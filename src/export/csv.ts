// CSV export of a run (ARCHITECTURE.md §11): always available, with the full citation list.
import { allCitations, formatCitation } from "../pipeline/verdicts";
import { currentAnswer } from "../store/runs";
import { VERDICT_LABEL, FLAG_LABEL } from "../ui/labels";
import type { ParentResult, Question } from "../types";

const cell = (v: string | number) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function runToCsv(questions: Question[], results: ParentResult[]): string {
  const byId = new Map(results.map((r) => [r.parentId, r]));
  const rows = [["Question", "Question text", "Verdict", "Answer", "Approved", "Citation", "All citations", "Quotes", "Flags", "Follow-up"]];
  for (const q of questions) {
    const r = byId.get(String(q.number));
    if (!r) {
      rows.push([String(q.number), q.text, "Not analysed yet", "", "", "", "", "", "", ""]);
      continue;
    }
    const { answer, citation } = currentAnswer(r);
    const quotes = r.items.flatMap((i) => i.evidence.map((e) => `${formatCitation(e)}: “${e.quote}”${i.status === "not_covered" ? " (disputed)" : ""}`));
    const flags = [...new Set(r.items.flatMap((i) => i.flags.map((f) => (f.detail && f.code !== "wording_differs" ? `${FLAG_LABEL[f.code]}: ${f.detail}` : FLAG_LABEL[f.code]))))];
    rows.push([
      String(q.number),
      q.text,
      VERDICT_LABEL[r.verdict],
      answer ? (answer === "yes" ? "Yes" : "No") : "",
      r.approved ? "Yes" : "No",
      citation,
      allCitations(r.items).join("; "),
      quotes.join("\n"),
      flags.join("\n"),
      r.followUp ?? "",
    ]);
  }
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function download(filename: string, data: string | Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
