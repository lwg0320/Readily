// npm run try:section -- s015
// Runs the real Policy Guide steps on one section: finds its obligations (Step 22), then checks
// them against every Medi-Cal policy (Step 24). `--find` stops after the obligations.
// With no section, lists the sections. Finished calls are saved under .cache/calls.
import { TASKS, type ModelKey, MODELS } from "../src/config/models";
import { createLLM, LLMError, UsageTracker } from "../src/llm/client";
import { findObligations } from "../src/pipeline/findObligations";
import { runSectionCheck } from "../src/pipeline/runSectionCheck";
import { splitSentences } from "../src/pipeline/sentences";
import { formatCitation } from "../src/pipeline/verdicts";
import { requireApiKey } from "./lib/env";
import { fileCallStore } from "./lib/fileStore";
import { loadGuide, loadLibrary } from "./lib/library";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const asModel = (v: string | undefined, fallback: ModelKey): ModelKey => (v === "opus" || v === "haiku" ? v : fallback);
const ids = args.filter((a) => /^s\d+$/.test(a));
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
  const guide = loadGuide("ecm-2026-01");
  if (!ids.length) {
    console.log(`${guide.title}: ${guide.sections.length} sections. Updated ones are marked *.\n`);
    for (const s of guide.sections) console.log(`${s.updated ? "*" : " "} ${s.id}  p.${String(s.pageStart).padStart(3)}  ${"  ".repeat(Math.min(s.path.length, 3))}${s.title.slice(0, 80)}`);
    console.log("\nUsage: npm run try:section -- s015        (find obligations, then check them)\n       npm run try:section -- s015 --find (find obligations only)\nOptions: --reading=opus  --review=opus  --fresh (ignore saved calls)");
    return;
  }
  const key = requireApiKey();
  const store = fileCallStore();
  if (args.includes("--fresh")) await store.clear();
  const tracker = new UsageTracker();
  const llm = createLLM({ apiKey: () => key, store });
  const models = { fullReading: asModel(flag("reading"), TASKS.fullReading.model), secondOpinion: asModel(flag("review"), TASKS.secondOpinion.model) };
  const library = args.includes("--find") ? null : loadLibrary();

  for (const id of ids) {
    const section = guide.sections.find((s) => s.id === id);
    if (!section) {
      console.error(`No section ${id}. Run without arguments to list them.`);
      continue;
    }
    console.log("─".repeat(100));
    console.log(`${section.id}  ${section.title}   (pages ${section.pageStart}–${section.pageEnd}${section.updated ? ", updated" : ""})`);
    const sentences = splitSentences(section);
    const found = await findObligations({ section, llm, tracker });
    console.log(`${sentences.length} sentences, ${sentences.filter((s) => s.cue).length} of them sound like a duty → ${found.obligations.length} obligations\n`);
    for (const o of found.obligations) {
      console.log(wrap(`${o.id} [${o.strength === "binding" ? "must" : "should"}, ${o.actor}, p.${o.page}] ${o.summary}`, "  "));
      console.log(wrap(`from ${o.sentenceIds.join(", ")}: “${o.sourceText}”`, "      "));
      if (o.searchTerms.length) console.log(wrap(`search terms: ${o.searchTerms.join(" | ")}`, "      "));
    }
    for (const n of found.nonObligations) console.log(wrap(`not an obligation, ${n.sentenceId}: ${n.reason} — “${sentences.find((s) => s.id === n.sentenceId)?.text.slice(0, 90)}…”`, "  "));
    for (const u of found.unexplained) console.log(wrap(`UNEXPLAINED ${u}: “${sentences.find((s) => s.id === u)?.text}”`, "  "));
    if (!library || !found.obligations.length) continue;

    console.log(`\nChecking against ${library.mediCal.length} Medi-Cal policies (full reading: ${MODELS[models.fullReading].label}, second opinion: ${MODELS[models.secondOpinion].label})…\n`);
    const run = await runSectionCheck({ guide, section, obligations: found.obligations, library, llm, models, tracker });
    for (const it of run.results[0].items) {
      console.log(wrap(`${{ covered: "✓ COVERED", not_covered: "✗ NOT FOUND", conflict: "! CONFLICT", needs_review: "? NEEDS REVIEW" }[it.status]}  ${it.item.id}  ${it.item.requirement}`, "  "));
      for (const e of it.evidence) console.log(wrap(`▸ ${formatCitation(e)}${it.status === "not_covered" ? " (disputed)" : ""}: “${e.quote}”`, "      "));
      if (it.readerReason) console.log(wrap(`reader: ${it.readerReason}`, "      "));
      if (it.reviewer) console.log(wrap(`second opinion: ${it.reviewer.agrees ? "agrees" : "DISAGREES"} — ${it.reviewer.reason}`, "      "));
      if (it.tieBreak) console.log(wrap(`tie-break: ${it.tieBreak.status} — ${it.tieBreak.reason}`, "      "));
      for (const f of it.flags) if (f.detail !== it.readerReason && f.detail !== it.reviewer?.reason) console.log(wrap(`flag ${f.code}: ${f.detail}`, "      "));
      if (it.trail) console.log(wrap(`not found after reading ${it.trail.policiesRead} Medi-Cal policies · ${it.trail.exactTerms.map((t) => `“${t.term}”: ${t.hits} ${t.hits === 1 ? "policy" : "policies"}`).join(" · ")}${it.trail.closest ? ` · closest: ${formatCitation(it.trail.closest)}` : ""}`, "      "));
    }
    console.log(wrap(`policies read in full: ${run.documentSets.map((d) => d.policies.map((p) => p.policyId).join(", ") + (d.lastLook ? " (last look)" : "")).join(" | ") || "none"}`, "\n  "));
  }

  console.log("\n" + "═".repeat(100));
  console.log("Cost by step (live calls only; saved calls are free):");
  for (const [task, u] of Object.entries(tracker.byTask)) console.log(`  ${task.padEnd(16)} ${String(u!.calls).padStart(4)} live, ${String(u!.savedCalls).padStart(4)} saved · out ${u!.output} · $${u!.cost.toFixed(4)}`);
  console.log(`  TOTAL $${tracker.totalCost.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err instanceof LLMError ? `\nStopped: ${err.message}` : err);
  process.exit(1);
});
