// npm run try -- 10 11 25
// Runs the real pipeline (Steps 7–15) on a few questions and prints what Alex would see.
// Finished calls are saved under .cache/calls, so running the same questions again is free.
import fs from "node:fs";
import path from "node:path";
import { MODELS, TASKS, type ModelKey } from "../src/config/models";
import { createLLM, LLMError, UsageTracker } from "../src/llm/client";
import { runQuestionnaire } from "../src/pipeline/runQuestionnaire";
import { sortByRisk } from "../src/pipeline/verdicts";
import type { ItemResult, Verdict } from "../src/types";
import { REPO_ROOT, requireApiKey } from "./lib/env";
import { fileCallStore } from "./lib/fileStore";
import { loadApl, loadLibrary, loadQuestionnaire } from "./lib/library";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : undefined;
};
const asModel = (v: string | undefined, fallback: ModelKey): ModelKey => (v === "opus" || v === "haiku" ? v : fallback);
const numbers = args.filter((a) => /^\d+$/.test(a)).map(Number);
const all = args.includes("--all");
if (!numbers.length && !all) {
  console.error("Usage: npm run try -- 10 11 25   (question numbers)\n       npm run try -- --all       (the whole questionnaire)\nOptions: --reading=opus  --review=opus  --fresh (ignore saved calls)");
  process.exit(1);
}

const VERDICT: Record<Verdict, string> = { covered: "COVERED", partial: "PARTIAL", conflict: "CONFLICT", not_found: "NOT FOUND", needs_review: "NEEDS REVIEW" };
const MARK: Record<ItemResult["status"], string> = { covered: "✓", not_covered: "✗", conflict: "!", needs_review: "?" };
const wrap = (s: string, indent: string, width = 100) => {
  const out: string[] = [];
  let line = "";
  for (const w of s.split(/\s+/)) {
    if ((line + " " + w).trim().length > width - indent.length) {
      out.push(indent + line.trim());
      line = w;
    } else line += " " + w;
  }
  if (line.trim()) out.push(indent + line.trim());
  return out.join("\n");
};

async function main() {
  const key = requireApiKey();
  const questionnaire = loadQuestionnaire("apl-25-008");
  const apl = loadApl(questionnaire.aplId);
  console.log("Loading the library…");
  const library = loadLibrary();
  const questions = all ? questionnaire.questions : questionnaire.questions.filter((q) => numbers.includes(q.number));
  const models = { fullReading: asModel(flag("reading"), TASKS.fullReading.model), secondOpinion: asModel(flag("review"), TASKS.secondOpinion.model) };

  const store = fileCallStore();
  if (args.includes("--fresh")) await store.clear();
  const tracker = new UsageTracker();
  let throttled = 0;
  const llm = createLLM({ apiKey: () => key, store, onThrottle: () => throttled++ });

  console.log(`${library.mediCal.length} Medi-Cal policies · APL ${apl.number} · questions ${questions.map((q) => q.number).join(", ")}`);
  console.log(`Full reading: ${MODELS[models.fullReading].short} · Second opinion: ${MODELS[models.secondOpinion].short}\n`);

  const started = Date.now();
  let lastLine = "";
  const status = (s: string) => {
    if (s === lastLine) return;
    lastLine = s;
    process.stdout.write(`\r${s.padEnd(78)}`);
  };
  const run = await runQuestionnaire({
    questions,
    apl,
    library,
    llm,
    models,
    tracker,
    onProgress: (e) => {
      if (e.stage === "checklist") status(`Turning questions into checks… ${e.done}/${e.total}`);
      if (e.stage === "screening") status(`Reading every Medi-Cal policy… ${e.done}/${e.total}`);
      if (e.stage === "reading") status(`Reading candidate policies in full, second opinion… group ${e.done}/${e.total}`);
    },
  });
  process.stdout.write("\r" + " ".repeat(80) + "\r");
  const seconds = Math.round((Date.now() - started) / 1000);

  const title = new Map(questions.map((q) => [String(q.number), q.text]));
  for (const r of sortByRisk(run.results)) {
    console.log("─".repeat(100));
    console.log(`Q${r.parentId}  ${VERDICT[r.verdict]}   suggested answer: ${r.suggestedAnswer ?? "— (you decide)"}${r.suggestedCitation ? `   citation: ${r.suggestedCitation}` : ""}`);
    console.log(wrap(title.get(r.parentId) ?? "", "  "));
    for (const it of r.items) {
      console.log(`\n  ${MARK[it.status]} ${it.item.id}  [${it.status}]`);
      console.log(wrap(it.item.requirement, "      "));
      for (const e of it.evidence) {
        console.log(`      ▸ ${e.policyId} §${e.address}, p.${e.page}${e.status === "corrected" ? " (quote corrected)" : ""}${it.status === "not_covered" ? " (disputed)" : ""}`);
        console.log(wrap(`“${e.quote}”`, "        "));
      }
      if (it.readerReason) console.log(wrap(`reader: ${it.readerReason}`, "      "));
      if (it.reviewer) console.log(wrap(`second opinion: ${it.reviewer.agrees ? "agrees" : "DISAGREES"} — ${it.reviewer.reason}`, "      "));
      for (const f of it.flags) console.log(wrap(`flag ${f.code}: ${f.detail}`, "      "));
      if (it.trail) {
        const t = it.trail;
        const terms = t.exactTerms.map((x) => `“${x.term}”: ${x.hits} ${x.hits === 1 ? "policy" : "policies"}`).join(" · ");
        console.log(wrap(`not found after reading ${t.policiesRead} Medi-Cal policies${terms ? ` · exact search ${terms}` : ""}${t.closest ? ` · closest: ${t.closest.policyId} §${t.closest.address}, p.${t.closest.page}` : ""}`, "      "));
      }
    }
    console.log();
  }

  console.log("═".repeat(100));
  const counts = run.results.reduce<Record<string, number>>((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {});
  console.log(`Verdicts: ${Object.entries(counts).map(([v, n]) => `${VERDICT[v as Verdict]} ${n}`).join(" · ")}`);
  console.log(`Checks: ${run.stats.items} from ${questions.length} question(s) · bundles: ${run.stats.bundles} · policies read per bundle: ${run.stats.policiesRead} · flagged by the reader: ${run.stats.screeningHits} · document sets read in full: ${run.stats.chunks} · rescued by the last look: ${run.stats.rescued}`);
  console.log(`Time: ${seconds}s${throttled ? ` · the API asked us to slow down ${throttled} time(s)` : ""}\n`);
  console.log("Cost by step (live calls only; saved calls are free):");
  for (const [task, u] of Object.entries(tracker.byTask)) {
    console.log(`  ${task.padEnd(16)} ${String(u!.calls).padStart(4)} live, ${String(u!.savedCalls).padStart(4)} saved · in ${u!.input} · cache write ${u!.cacheWrite} · cache read ${u!.cacheRead} · out ${u!.output} · $${u!.cost.toFixed(4)}`);
  }
  console.log(`  TOTAL $${tracker.totalCost.toFixed(4)}`);

  const dir = path.join(REPO_ROOT, ".cache", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `try-${questions.map((q) => q.number).join("-").slice(0, 40)}.json`);
  fs.writeFileSync(file, JSON.stringify({ models, results: run.results, checklists: run.checklists, foundBy: run.foundBy, stats: run.stats, usage: tracker.byTask, seconds }, null, 1));
  console.log(`\nFull results saved to ${path.relative(REPO_ROOT, file)}`);
}

main().catch((err) => {
  process.stdout.write("\n");
  console.error(err instanceof LLMError ? `Stopped: ${err.message}` : err);
  process.exit(1);
});
