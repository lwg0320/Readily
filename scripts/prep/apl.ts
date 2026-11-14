// All Plan Letters (ARCHITECTURE.md §5.3). Regulator documents: never cited as plan evidence.
import path from "node:path";
import { pdfToPages } from "./extract";

export type Apl = {
  id: string; // file base name, e.g. "APL25-008"
  kind: "regulator";
  number: string; // "25-008"
  subject: string;
  date: string | null; // ISO
  supersedes: string[];
  pageCount: number;
  pages: { page: number; text: string }[];
  sourceFile: string;
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function longDateToIso(s: string): string | null {
  const m = s.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

export function parseApl(file: string): Apl {
  const rawPages = pdfToPages(file);
  const first = rawPages[0].join("\n");
  const number = (first.match(/ALL PLAN LETTER\s+(\d{2}-\d{3})/) || [])[1] || "";
  const supersedes = [...first.matchAll(/SUPERSEDES\s+ALL PLAN LETTERS?\s+((?:\d{2}-\d{3}(?:\s*(?:,|AND)\s*)?)+)/gi)]
    .flatMap((m) => [...m[1].matchAll(/\d{2}-\d{3}/g)].map((x) => x[0]));
  const date = longDateToIso((first.match(/DATE:\s+(.+)/) || [])[1] || "");
  const subjLine = rawPages[0].findIndex((l) => /SUBJECT:/.test(l));
  let subject = "";
  if (subjLine >= 0) {
    subject = rawPages[0][subjLine].replace(/.*SUBJECT:\s*/, "").trim();
    // a subject may wrap onto following indented lines until the next label
    for (let i = subjLine + 1; i < rawPages[0].length; i++) {
      const l = rawPages[0][i];
      if (!l.trim() || /^\s*[A-Z ]{3,}:/.test(l)) break;
      subject += " " + l.trim();
    }
  }

  const pages = rawPages.map((lines, i) => {
    let ls = lines.map((l) => l.replace(/\s+$/, ""));
    if (i > 0) {
      // running header: "APL 25-008" / "Page 2"
      let dropped = 0;
      ls = ls.filter((l) => {
        if (dropped < 2 && (/^\s*APL\s+\d{2}-\d{3}\s*$/.test(l) || /^\s*Page\s+\d+\s*$/.test(l))) {
          dropped++;
          return false;
        }
        return true;
      });
    }
    const text = ls
      .map((l) => l.trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { page: i + 1, text };
  });

  return {
    id: path.basename(file).replace(/\.pdf$/i, ""),
    kind: "regulator",
    number,
    subject,
    date,
    supersedes: [...new Set(supersedes)],
    pageCount: rawPages.length,
    pages,
    sourceFile: path.basename(file),
  };
}
