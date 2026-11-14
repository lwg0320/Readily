// Policy Guide section list (ARCHITECTURE.md §5.5): PDF bookmarks + "(Updated …)" markers.
import fs from "node:fs";
import { pdfToPages } from "./extract";

export type GuideSection = {
  id: string;
  title: string;
  path: string[];
  pageStart: number;
  pageEnd: number;
  updated: boolean;
  source: "bookmark" | "marker";
  wordCount: number;
  text: string; // with <<page N>> markers
  parentIntro: string;
};

export type Guide = {
  id: string;
  title: string;
  date: string;
  pageCount: number;
  sections: GuideSection[];
  stats: { bookmarkHeadings: number; markerStarts: number; updatedSections: number; droppedShort: number; notLocated: number; footnotes: number };
};

const UPDATED_LINE = /^\s*(\(Updated [A-Z][a-z]+ (?:\d{1,2}, )?\d{4}\))\s*(.*)$/;
const BARE_UPDATED = /^\(Updated [A-Z][a-z]+ (?:\d{1,2}, )?\d{4}\)$/;
const CHAPTER = /^[IVX]+\.\s/;

type Heading = { title: string; page: number; path: string[] };

async function readBookmarks(file: string): Promise<Heading[]> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(file));
  const pdf = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  const outline = (await pdf.getOutline()) || [];
  const fileBase = file.split("/").pop()!.replace(/\.pdf$/i, "");

  const isWrapper = (t: string, depth: number) =>
    /^ECM[- ]Policy[- ]Guide/i.test(t) ||
    /\.pdf$/i.test(t) ||
    t === fileBase ||
    /POLICY\s+GUIDE$/i.test(t) ||
    /^TABLE OF CONTENTS$/i.test(t) ||
    (depth === 0 && /Policy Guide Edits$/i.test(t));

  const pageOf = async (dest: any): Promise<number | null> => {
    try {
      const d = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
      if (!d || !d[0]) return null;
      if (typeof d[0] === "number") return d[0] + 1;
      return (await pdf.getPageIndex(d[0])) + 1;
    } catch {
      return null;
    }
  };

  const out: Heading[] = [];
  const walk = async (items: any[], depth: number, ancestors: string[]) => {
    for (const it of items) {
      const title = String(it.title || "").replace(/\s+/g, " ").trim();
      const wrapper = isWrapper(title, depth);
      const bare = BARE_UPDATED.test(title);
      const page = await pageOf(it.dest);
      if (!wrapper && !bare && page && title) out.push({ title, page, path: ancestors });
      const next = wrapper || bare || !title ? ancestors : [...ancestors, title];
      if (it.items?.length) await walk(it.items, depth + 1, next);
    }
  };
  await walk(outline, 0, []);
  await pdf.destroy();
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** Finds the line where a heading starts on a page (the title may wrap over lines). */
function locate(lines: string[], title: string, from: number): number {
  const target = squash(title);
  if (!target) return -1;
  for (let i = from; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let acc = "";
    for (let j = i; j < Math.min(lines.length, i + 4); j++) {
      acc += squash(lines[j]);
      if (acc.startsWith(target)) return i;
      if (!target.startsWith(acc)) break;
    }
  }
  // fallback: a line that contains the whole title
  for (let i = from; i < lines.length; i++) if (squash(lines[i]).includes(target)) return i;
  return -1;
}

function firstParagraph(text: string, maxWords: number): string {
  const clean = text.replace(/<<page \d+>>\n?/g, "");
  const para = clean.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).find((p) => p.split(" ").length >= 8);
  if (!para) return "";
  const words = para.split(" ");
  return words.length > maxWords ? words.slice(0, maxWords).join(" ") + " …" : para;
}

export async function parseGuide(file: string, id: string, title: string, date: string): Promise<Guide> {
  // Footnotes sit at the bottom of each page as a number on its own line followed by text.
  // Left in place they cut sentences that continue on the next page, so they are lifted out
  // here and re-attached at the end of the section that is open at the bottom of that page.
  const footnotes = new Map<number, { n: number; text: string }[]>();
  let lastNote = 0;
  const pages = pdfToPages(file).map((rawLines, pi) => {
    let lines = rawLines.map((l) => l.replace(/\s+$/, ""));
    const isNoteStart = (l: string) => {
      const m = l.match(/^ {0,2}(\d{1,3})$/);
      return m && Number(m[1]) >= lastNote && Number(m[1]) <= lastNote + 3 ? Number(m[1]) : 0;
    };
    const first = lines.findIndex((l) => isNoteStart(l) > 0);
    if (first >= 0) {
      const notes: { n: number; text: string }[] = [];
      for (const l of lines.slice(first)) {
        const n = isNoteStart(l);
        if (n) {
          notes.push({ n, text: "" });
          lastNote = n;
        } else if (/^\s*\d{1,3}\s*$/.test(l)) {
          continue; // page number
        } else if (notes.length && l.trim()) {
          notes[notes.length - 1].text += (notes[notes.length - 1].text ? " " : "") + l.trim();
        }
      }
      footnotes.set(pi + 1, notes.filter((x) => x.text));
      lines = lines.slice(0, first);
    }
    return lines.filter((l) => !/^\s*\d{1,3}\s*$/.test(l)); // lone page numbers
  });
  const headings = await readBookmarks(file);

  type Start = { page: number; line: number; title: string; path: string[]; source: "bookmark" | "marker"; titleLines: number };
  const starts: Start[] = [];
  let notLocated = 0;
  const lastLineOnPage = new Map<number, number>();
  for (const h of headings) {
    const lines = pages[h.page - 1] || [];
    let line = locate(lines, h.title, 0);
    if (line < 0) {
      notLocated++;
      line = Math.min((lastLineOnPage.get(h.page) ?? -1) + 1, Math.max(0, lines.length - 1));
    }
    lastLineOnPage.set(h.page, Math.max(lastLineOnPage.get(h.page) ?? -1, line));
    starts.push({ page: h.page, line, title: h.title, path: h.path, source: "bookmark", titleLines: 1 });
  }

  // Extra starts: "(Updated January 2026) …" lines that are not already bookmark headings.
  const taken = new Set(starts.map((s) => `${s.page}:${s.line}`));
  let markerStarts = 0;
  pages.forEach((lines, pi) => {
    lines.forEach((text, li) => {
      const m = text.match(UPDATED_LINE);
      if (!m || !m[2].trim()) return; // a bare marker belongs to the heading around it
      if (taken.has(`${pi + 1}:${li}`)) return;
      const rest = m[2].trim();
      const colon = rest.indexOf(":");
      const label = colon > 0 && colon <= 90 ? rest.slice(0, colon) : rest;
      starts.push({ page: pi + 1, line: li, title: `${m[1]} ${label}`.trim(), path: [], source: "marker", titleLines: 0 });
      markerStarts++;
    });
  });

  starts.sort((a, b) => a.page - b.page || a.line - b.line);

  // Paths: marker sections take the path of the closest preceding bookmark heading;
  // every path starts at its chapter ("IV. ECM POPULATIONS OF FOCUS").
  let chapter = "";
  let lastBookmarkPath: string[] = [];
  for (const s of starts) {
    if (s.source === "bookmark") {
      if (CHAPTER.test(s.title) || /^Appendix [A-Z]\b/i.test(s.title)) chapter = s.title;
      lastBookmarkPath = s.path;
    } else {
      s.path = lastBookmarkPath;
    }
    const top = s.path[0] || "";
    if (chapter && s.title !== chapter && !CHAPTER.test(top) && !/^Appendix [A-Z]\b/i.test(top)) s.path = [chapter, ...s.path];
  }

  // Slice the text between starts.
  const textBetween = (a: Start, b: Start | null): { text: string; pageEnd: number } => {
    let out = "";
    let pageEnd = a.page;
    const notes: string[] = [];
    const lastPage = b ? b.page : pages.length;
    for (let p = a.page; p <= lastPage; p++) {
      const lines = pages[p - 1];
      const from = p === a.page ? a.line : 0;
      const to = b && p === b.page ? b.line : lines.length;
      const chunk = lines.slice(from, to);
      if (!chunk.some((l) => l.trim())) continue;
      out += `<<page ${p}>>\n` + chunk.map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
      pageEnd = p;
      if (to === lines.length) for (const f of footnotes.get(p) || []) notes.push(`[Footnote ${f.n}, p.${p}] ${f.text}`);
    }
    if (notes.length) out += "\nFootnotes:\n" + notes.join("\n") + "\n";
    return { text: out.trim(), pageEnd };
  };

  const raw = starts.map((s, i) => {
    const { text, pageEnd } = textBetween(s, starts[i + 1] || null);
    const body = text.replace(/<<page \d+>>/g, " ");
    return { start: s, text, pageEnd, wordCount: body.split(/\s+/).filter(Boolean).length };
  });

  // First paragraph under each heading, used as context for the sections below it.
  const intros = raw.map((r) => {
    const body = r.text.split("\nFootnotes:\n")[0].replace(/<<page \d+>>\n?/, "").split("\n").slice(1).join("\n");
    return firstParagraph(body, 120);
  });
  const introFor = (i: number): string => {
    const path = raw[i].start.path;
    for (let k = path.length - 1; k >= 0; k--) {
      for (let j = i - 1; j >= 0; j--) {
        if (raw[j].start.title === path[k]) {
          if (intros[j]) return intros[j];
          break;
        }
      }
    }
    return "";
  };

  const sections: GuideSection[] = [];
  let droppedShort = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (r.wordCount < 20) {
      droppedShort++;
      continue;
    }
    const parentIntro = introFor(i);
    const firstLines = r.text.replace(/<<page \d+>>\n?/, "").split("\n").slice(0, 2).join(" ");
    sections.push({
      id: `s${String(sections.length + 1).padStart(3, "0")}`,
      title: r.start.title,
      path: r.start.path,
      pageStart: r.start.page,
      pageEnd: r.pageEnd,
      updated: /\(Updated/.test(r.start.title) || /\(Updated/.test(firstLines),
      source: r.start.source,
      wordCount: r.wordCount,
      text: r.text,
      parentIntro,
    });
  }

  return {
    id,
    title,
    date,
    pageCount: pages.length,
    sections,
    stats: {
      bookmarkHeadings: headings.length,
      markerStarts,
      updatedSections: sections.filter((s) => s.updated).length,
      droppedShort,
      notLocated,
      footnotes: [...footnotes.values()].reduce((a, b) => a + b.length, 0),
    },
  };
}
