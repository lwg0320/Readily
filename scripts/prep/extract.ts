// PDF text extraction with Poppler (ARCHITECTURE.md §5.1).
import { execFileSync } from "node:child_process";

export type Line = { text: string; page: number };

/** Returns the lines of each page, as printed by `pdftotext -layout`. */
export function pdfToPages(file: string): string[][] {
  let out: string;
  try {
    out = execFileSync("pdftotext", ["-layout", file, "-"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error("pdftotext was not found. Install Poppler first (macOS: brew install poppler).");
    }
    throw err;
  }
  const pages = out.split("\f");
  if (pages.length > 1 && pages[pages.length - 1].trim() === "") pages.pop();
  return pages.map((p) => p.replace(/\r/g, "").split("\n"));
}

const FOOTER = /Page\s+\d+\s+of\s+\d+/;

/**
 * Removes a P&P page footer ("Page 2 of 18  GG.1503: <title>  Revised Date: ...") and any
 * title continuation line under it. The footer is always within the last few lines of a page.
 */
export function dropPolicyFooter(lines: string[]): string[] {
  const nonEmpty: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) nonEmpty.push(i);
  const tail = nonEmpty.slice(-4);
  for (const i of tail) {
    if (!FOOTER.test(lines[i])) continue;
    // Some footers put "GG.1330: <title>" on the line above "Page 19 of 19".
    const k = nonEmpty.indexOf(i);
    const above = k > 0 ? nonEmpty[k - 1] : -1;
    if (above >= 0 && /^\s*[A-Z]{2,4}\.\d{3,4}[a-z]?:\s/.test(lines[above])) return lines.slice(0, above);
    return lines.slice(0, i);
  }
  return lines;
}

export function toLines(pages: string[][]): Line[] {
  const out: Line[] = [];
  pages.forEach((lines, i) => {
    for (const text of lines) out.push({ text: text.replace(/\s+$/, ""), page: i + 1 });
  });
  return out;
}

export function indentOf(s: string): number {
  const m = s.match(/^ */);
  return m ? m[0].length : 0;
}
