// npm run check:key — a real, tiny end-to-end check of the API client. Costs under one cent.
// It checks: the key, the request format, JSON output, the saved-call store, and prompt caching.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createLLM, LLMError, memoryStore, UsageTracker } from "../src/llm/client";
import { MODELS, TASKS } from "../src/config/models";
import { JSON_INSTRUCTION } from "../src/llm/client";
import { REPO_ROOT, requireApiKey } from "./lib/env";

const key = requireApiKey();
const tracker = new UsageTracker();
const llm = createLLM({ apiKey: () => key, store: memoryStore(), onThrottle: (ms) => console.log(`  (API asked us to wait ${ms / 1000}s)`) });
const line = (ok: boolean, text: string) => console.log(`  ${ok ? "PASS" : "FAIL"}  ${text}`);
let failures = 0;
const check = (ok: boolean, text: string) => {
  if (!ok) failures++;
  line(ok, text);
};

async function main() {
  console.log(`Model for every task: ${MODELS[TASKS.fullReading.model].id}\n`);

  console.log("1. Key");
  const t = await llm.testKey();
  check(t.ok, t.ok ? "the key works" : `the key was not accepted (${t.kind}): ${t.message}`);
  if (!t.ok) process.exit(1);

  console.log("\n2. A call that returns JSON");
  const schema = z.object({ hits: z.array(z.object({ itemId: z.string(), address: z.string() })) });
  const request = {
    task: "readEveryPolicy" as const,
    system: [{ text: `You are screening one policy document. Requirements:\nR1: Members are notified of Class I medication recalls within 5 calendar days.\nReport which requirements the document addresses and the section address. ${JSON_INSTRUCTION} Shape: {"hits":[{"itemId":"R1","address":"III.A.3.a"}]}` }],
    user: [{ text: "III. PROCEDURE\nA. Medication recalls\n3. a. In the event the FDA issues a Class I Medication Recall, CalOptima Health pharmacists shall notify affected Members, in writing via U.S. mail, no later than five (5) calendar days from the date of the FDA medication recall announcement." }],
    schema,
    tracker,
  };
  const first = await llm.call(request);
  check(first.data.hits.some((h) => h.itemId === "R1"), `valid JSON came back: ${JSON.stringify(first.data)}`);
  check(first.usage.output > 0 && first.cost > 0, `usage recorded: ${first.usage.input} in, ${first.usage.output} out, $${first.cost.toFixed(5)}`);

  console.log("\n3. Saved-call store");
  const started = Date.now();
  const second = await llm.call(request);
  check(second.fromSavedCache && second.cost === 0, `the same call again was answered from the saved store in ${Date.now() - started} ms, at no cost`);

  console.log("\n4. Prompt caching (one policy shared by three questions)");
  const policy = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "public/data/policies/GG.1503.json"), "utf8"));
  const yesNo = z.object({ answer: z.enum(["yes", "no"]), section: z.string() });
  const questions = [
    "Does the policy say hospice election periods are two 90-day periods followed by unlimited 60-day periods?",
    "Does the policy define Terminally Ill?",
    "Does the policy mention Revenue Code 0657?",
  ];
  const results = await llm.warmThenAll(
    questions.map((q) => () =>
      llm.call({
        task: "fullReading",
        system: [{ text: "You answer questions about one policy document." }],
        user: [{ text: policy.canonicalText, cache: true }, { text: `${q} Give the section address. ${JSON_INSTRUCTION} Shape: {"answer":"yes","section":"II.D"}` }],
        schema: yesNo,
        tracker,
      }),
    ),
  );
  results.forEach((r, i) => {
    if (r instanceof LLMError) return check(false, `question ${i + 1} failed: ${r.message}`);
    console.log(`     q${i + 1}: ${r.data.answer} (${r.data.section}) · cache write ${r.usage.cacheWrite} · cache read ${r.usage.cacheRead} · fresh input ${r.usage.input}`);
  });
  const ok = results.filter((r): r is Exclude<typeof r, LLMError> => !(r instanceof LLMError));
  check(ok.length === 3, "all three questions were answered");
  check((ok[0]?.usage.cacheWrite ?? 0) > 5000, "the first call wrote the policy to the cache");
  check(ok.slice(1).every((r) => r.usage.cacheRead > 5000), "the next two calls read the policy from the cache");

  console.log(`\nTotal: ${tracker.totalCalls} live calls, $${tracker.totalCost.toFixed(4)}`);
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof LLMError ? `\nStopped: ${err.message}` : err);
  process.exit(1);
});
