// Policy parsing (ARCHITECTURE.md §5.2).
import fs from "node:fs";
import path from "node:path";
import { dropPolicyFooter, indentOf, pdfToPages, type Line } from "./extract";
import { estimateTokens } from "../../src/lib/text";

export type SpanKind = "body" | "glossary" | "references";
export type Scope = "medi-cal" | "other" | "both";

export type Policy = {
  id: string;
  title: string;
  department: string;
  section: string;
  effectiveDate: string | null;
  revisedDate: string | null;
  programs: { mediCal: boolean; oneCare: boolean; pace: boolean; administrative: boolean };
  pageCount: number;
  referencedApls: string[];
  canonicalText: string;
  tokenEstimate: number;
  spans: { start: number; end: number; page: number; address: string; kind: SpanKind; scope: Scope }[];
  outline: { address: string; firstLine: string; pageStart: number; pageEnd: number }[];
  folder: string;
  sourceFile: string;
  warnings: string[];
};

type Block = { text: string; page: number; address: string; kind: SpanKind; scope: Scope };

const ROMANS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const ROMAN_HEADER = /^\s{0,12}(I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII)\.\s+([A-Z][A-Za-z &()\/'’,\-]+?)\s*$/;

function usDateToIso(d: string | undefined | null): string | null {
  if (!d) return null;
  const m = d.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

function isoToUs(d: string | null): string {
  if (!d) return "unknown";
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}

// ---------------------------------------------------------------- header

function fieldWithContinuation(lines: string[], label: RegExp): string {
  const isLabel = /^\s*[A-Z][A-Za-z()\/ ]{1,28}:(\s|$)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(label);
    if (!m) continue;
    const parts = [m[1].trim()];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim() || isLabel.test(l) || /[☒☐]/.test(l)) break;
      parts.push(l.trim());
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

function parseHeader(headerLines: string[], fileName: string) {
  const text = headerLines.join("\n");
  const id = (text.match(/Policy:\s+(\S+)/) || [])[1] || "";
  const title = fieldWithContinuation(headerLines, /Title:\s+(.*)$/);
  const department = fieldWithContinuation(headerLines, /Department(?:\(s\))?:\s+(.*)$/);
  const section = fieldWithContinuation(headerLines, /Section:\s+(.*)$/);
  const effectiveDate = usDateToIso((text.match(/Effective(?: Date)?:\s+(\d{2}\/\d{2}\/\d{4})/) || [])[1]);
  let revisedDate = usDateToIso((text.match(/Revised(?: Date)?:\s+(\d{2}\/\d{2}\/\d{4})/) || [])[1]);
  if (!revisedDate) {
    const v = fileName.match(/_v\.?(\d{4})(\d{2})(\d{2})(?!\d)/);
    if (v) revisedDate = `${v[1]}-${v[2]}-${v[3]}`;
  }
  if (!revisedDate) revisedDate = effectiveDate;
  const checked = (name: string) => new RegExp(`☒\\s*${name}`).test(text);
  return {
    id,
    title,
    department,
    section,
    effectiveDate,
    revisedDate,
    programs: {
      mediCal: checked("Medi-Cal"),
      oneCare: checked("OneCare"),
      pace: checked("PACE"),
      administrative: checked("Administrative"),
    },
  };
}

// ---------------------------------------------------------------- sections

type Section = { roman: string; title: string; kind: SpanKind | "admin"; lines: Line[]; page: number };

function sectionKind(title: string): SpanKind | "admin" {
  const t = title.replace(/\s+/g, "").toUpperCase();
  if (/GLOSSARY|DEFINITION/.test(t)) return "glossary";
  if (/REFERENCE/.test(t)) return "references";
  if (/ATTACHMENT|APPROVAL|BOARD|HISTORY|REVIS|REVIEW/.test(t)) return "admin";
  return "body";
}

function matchRomanHeader(text: string, lastIndex: number): { roman: string; title: string; index: number } | null {
  const m = text.match(ROMAN_HEADER);
  if (!m) return null;
  const letters = [...m[2]].filter((c) => /[A-Za-z]/.test(c));
  if (letters.length < 3) return null;
  const upper = letters.filter((c) => c === c.toUpperCase()).length;
  if (upper / letters.length < 0.8) return null;
  const index = ROMANS.indexOf(m[1]);
  // Must come after the previous section; tolerate one or two skipped numerals.
  if (index <= lastIndex || index > lastIndex + 3) return null;
  return { roman: m[1], title: m[2].trim(), index };
}

function splitSections(lines: Line[]): { header: Line[]; sections: Section[] } {
  const header: Line[] = [];
  const sections: Section[] = [];
  let last = -1;
  for (const line of lines) {
    const h = matchRomanHeader(line.text, last);
    if (h) {
      last = h.index;
      sections.push({ roman: h.roman, title: h.title, kind: sectionKind(h.title), lines: [], page: line.page });
    } else if (sections.length) {
      sections[sections.length - 1].lines.push(line);
    } else {
      header.push(line);
    }
  }
  return { header, sections };
}

// ---------------------------------------------------------------- outline

type LabelType = "U" | "D" | "L" | "R";
const LEVEL_OF: Record<LabelType, number> = { U: 1, D: 2, L: 3, R: 4 };
const TYPE_AT: LabelType[] = ["U", "U", "D", "L", "R"]; // index = level

function romanToInt(s: string): number | null {
  if (!/^[ivxl]+$/.test(s)) return null;
  const val: Record<string, number> = { i: 1, v: 5, x: 10, l: 50 };
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const a = val[s[i]];
    const b = val[s[i + 1]] || 0;
    total += a < b ? -a : a;
  }
  return intToRoman(total) === s ? total : null;
}

function intToRoman(n: number): string {
  const table: [number, string][] = [[50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [v, r] of table) while (n >= v) { out += r; n -= v; }
  return out;
}

function letterIndex(label: string): number | null {
  // a=1 … z=26, aa=27 … zz=52
  const l = label.toLowerCase();
  if (l.length === 1) return l.charCodeAt(0) - 96;
  if (l.length === 2 && l[0] === l[1]) return 26 + l.charCodeAt(0) - 96;
  return null;
}

function ordinal(label: string, type: LabelType): number | null {
  if (type === "D") return /^\d+$/.test(label) ? Number(label) : null;
  if (type === "U") return /^[A-Z]{1,2}$/.test(label) ? letterIndex(label) : null;
  if (type === "L") return /^[a-z]{1,2}$/.test(label) ? letterIndex(label) : null;
  return romanToInt(label);
}

/** Debug aid: outline labels that looked like item starts but did not fit the sequence. */
export const REJECTED_LABELS: { label: string; text: string }[] = [];

const ITEM_START = /^(\s*)([A-Z]{1,2}|\d{1,2}|[a-z]{1,2}|[ivxl]{1,6})\.\s+(\S.*)$/;

type Item = {
  address: string;
  level: number;
  parent: Item | null;
  ownLines: string[]; // text directly under this item, before its first child
  hasChild: boolean;
  scope: Scope;
};

type OutLine = { text: string; page: number; item: Item; depth: number };

function parseOutline(section: Section): { lines: OutLine[]; items: Item[] } {
  const root: Item = { address: section.roman, level: 0, parent: null, ownLines: [], hasChild: false, scope: "both" };
  const items: Item[] = [root];
  const stack: (null | { label: string; ord: number; indent: number; item: Item })[] = [null, null, null, null, null];
  const out: OutLine[] = [];
  let current = root;

  const deepest = () => {
    for (let k = 4; k >= 1; k--) if (stack[k]) return k;
    return 0;
  };
  const parentAt = (level: number): Item => {
    for (let k = level - 1; k >= 1; k--) if (stack[k]) return stack[k]!.item;
    return root;
  };
  const open = (level: number, label: string, ord: number, indent: number) => {
    const parent = parentAt(level);
    const item: Item = {
      address: `${parent.address}.${label}`,
      level,
      parent,
      ownLines: [],
      hasChild: false,
      scope: "both",
    };
    parent.hasChild = true;
    stack[level] = { label, ord, indent, item };
    for (let k = level + 1; k <= 4; k++) stack[k] = null;
    items.push(item);
    current = item;
  };

  for (const line of section.lines) {
    if (!line.text.trim()) continue;
    const m = line.text.match(ITEM_START);
    let started = false;
    if (m) {
      const indent = m[1].length;
      const label = m[2];
      // 1. next sibling at an existing level (deepest first)
      for (let k = 4; k >= 1 && !started; k--) {
        const s = stack[k];
        if (!s) continue;
        const ord = ordinal(label, TYPE_AT[k]);
        if (ord === null) continue;
        if (ord === s.ord + 1 || (ord === s.ord + 2 && Math.abs(indent - s.indent) <= 3)) {
          open(k, label, ord, indent);
          started = true;
        }
      }
      // 2. first child below the deepest open level
      if (!started) {
        const d = deepest();
        for (let c = d + 1; c <= 4 && !started; c++) {
          if (ordinal(label, TYPE_AT[c]) === 1) {
            open(c, label, 1, indent);
            started = true;
          }
        }
      }
    }
    if (m && !started) REJECTED_LABELS.push({ label: m[2], text: line.text.trim().slice(0, 80) });
    let text: string;
    if (started && m) text = `${m[2]}. ${cleanInner(m[3])}`;
    else text = cleanInner(line.text.trim());
    if (!current.hasChild || started) current.ownLines.push(started && m ? cleanInner(m[3]) : text);
    out.push({ text, page: line.page, item: current, depth: current.level + (started ? 0 : 1) });
  }
  return { lines: out, items };
}

function cleanInner(s: string): string {
  return s.replace(/\s{3,}/g, "   ").replace(/(?<=\S) {2}(?=\S)/g, " ");
}

// ---------------------------------------------------------------- program scope

function scopeFromOwnText(own: string): Scope | null {
  const text = own.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const hasMediCal = (s: string) => /Medi-\s?Cal/i.test(s);
  const hasOther = (s: string) => /\b(Medicare|OneCare)\b/.test(s);

  // "For Medicare covered services, …" / "For OneCare Members:" / "For Medi-Cal …"
  if (/^For (Medicare|OneCare|Medi-\s?Cal)\b/.test(text)) {
    const lead = text.split(" ").slice(0, 8).join(" ");
    if (hasOther(lead) && !hasMediCal(lead)) return "other";
    if (hasMediCal(lead) && !hasOther(lead)) return "medi-cal";
    return null;
  }

  // Short headings that name one program, e.g. "Medicare Hospice Benefit Eligibility Requirements:".
  // Deliberately narrow: "Medicare Crossover" in a Medi-Cal policy is still Medi-Cal content.
  const words = text.split(" ").length;
  const headingLike = words <= 14 && (/:$/.test(text) || !/[.;]$|;\s*(and|or)$/i.test(text));
  if (!headingLike) return null;
  const PROGRAM_NOUN = /\b(Eligibility|Requirements?|Members?|Benefits?)\b/i;
  const other =
    /^(OneCare|Medicare)(\s*\((OneCare|Medicare)\))?\s*:?$/.test(text) ||
    (/^(Medicare|OneCare)\b/.test(text) && PROGRAM_NOUN.test(text)) ||
    /\b(applicable to|for) (the )?(Medicare|OneCare)\b/i.test(text);
  const mediCal =
    /^Medi-\s?Cal\s*:?$/i.test(text) ||
    (/^Medi-\s?Cal\b/i.test(text) && PROGRAM_NOUN.test(text)) ||
    /\b(applicable to|for) (the |CalOptima Health )?Medi-\s?Cal\b/i.test(text);
  if (other && !hasMediCal(text)) return "other";
  if (mediCal && !hasOther(text)) return "medi-cal";
  return null;
}

function assignScopes(items: Item[]) {
  for (const item of items) {
    // items are in document order, so parents are always resolved first
    const own = item.level === 0 ? null : scopeFromOwnText(item.ownLines.join(" "));
    item.scope = own ?? item.parent?.scope ?? "both";
  }
}

// ---------------------------------------------------------------- glossary

type GlossaryEntry = { term: string; chunks: { page: number; text: string }[]; termOpen: boolean };

const TERM_HEADER = /^\s*Term\s+Definition\s*$/;

function appendChunk(entry: GlossaryEntry, page: number, text: string) {
  if (!text) return;
  const last = entry.chunks[entry.chunks.length - 1];
  if (last && last.page === page) last.text += " " + text;
  else entry.chunks.push({ page, text });
}

function defText(entry: GlossaryEntry): string {
  return entry.chunks.map((c) => c.text).join(" ");
}

function parseTableGlossary(lines: Line[]): { entries: GlossaryEntry[]; preamble: Line[] } {
  const entries: GlossaryEntry[] = [];
  const preamble: Line[] = [];
  let termIndent = -1;
  let current: GlossaryEntry | null = null;
  let prevWasTermLevel = false;
  // One policy (GG.1815) has stray auto-numbering ("XI.  Member …") in front of its terms.
  const rows = lines
    .filter((l) => l.text.trim())
    .map((l) => ({ ...l, text: l.text.replace(/^(\s*)([IVX]{1,4}\.)(?=\s{2,}\S)/, (_m, a, b) => a + " ".repeat(b.length)) }));

  for (let i = 0; i < rows.length; i++) {
    const { text, page } = rows[i];
    if (TERM_HEADER.test(text)) {
      termIndent = indentOf(text);
      prevWasTermLevel = false;
      continue;
    }
    if (termIndent < 0) {
      preamble.push(rows[i]);
      continue;
    }
    const indent = indentOf(text);
    const termLevel = indent <= termIndent + 3;
    if (!termLevel) {
      if (current) appendChunk(current, page, cleanInner(text.trim()));
      else preamble.push(rows[i]);
      prevWasTermLevel = false;
      if (current) current.termOpen = false;
      continue;
    }

    // Estimate the definition column from nearby lines on the same page (the column shifts
    // from page to page): definition-only lines, or term lines with a clear gap.
    const colAt = (j: number): number => {
      const t = rows[j].text;
      const ind = indentOf(t);
      if (ind > termIndent + 3) return ind;
      const g = t.match(/^(\s*\S(?:.*?\S)?)\s{2,}\S/);
      return g ? t.length - t.slice(g[1].length).trimStart().length : -1;
    };
    let defCol = -1;
    for (let j = i + 1; j < rows.length && j <= i + 15 && defCol < 0; j++) {
      if (rows[j].page !== page || TERM_HEADER.test(rows[j].text)) break;
      defCol = colAt(j);
      // a block of definition-only lines may start with an indented list item: take its minimum
      for (let k = j + 1; defCol >= 0 && k < rows.length && k <= j + 6; k++) {
        if (rows[k].page !== page || indentOf(rows[k].text) <= termIndent + 3) break;
        defCol = Math.min(defCol, indentOf(rows[k].text));
      }
    }
    for (let j = i - 1; j >= 0 && j >= i - 15 && defCol < 0; j--) {
      if (rows[j].page !== page || TERM_HEADER.test(rows[j].text)) break;
      defCol = colAt(j);
    }

    let left = text.trim();
    let right = "";
    const gap = text.match(/^(\s*)(\S(?:.*?\S)?)\s{2,}(\S.*)$/);
    if (gap) {
      const leftEnd = gap[1].length + gap[2].length;
      const rightStart = text.length - gap[3].length;
      if (defCol < 0 || Math.abs(rightStart - defCol) <= 3 || leftEnd <= defCol) {
        // Use the gap closest to the definition column when there are several.
        left = gap[2];
        right = gap[3];
        if (defCol >= 0 && Math.abs(rightStart - defCol) > 3) {
          const split = splitNearColumn(text, defCol);
          if (split) [left, right] = split;
        }
      }
    }
    if (!right && defCol >= 0 && text.length > defCol) {
      const split = splitNearColumn(text, defCol);
      if (split) [left, right] = split;
    }
    left = left.trim();
    right = cleanInner(right.trim());

    if (!right) {
      // A term fragment on its own line.
      if (current && current.termOpen) current.term += " " + left;
      else {
        current = { term: left, chunks: [], termOpen: true };
        entries.push(current);
      }
    } else {
      const prev = current ? defText(current) : "";
      const startsNew =
        !current ||
        !prevWasTermLevel ||
        !current.termOpen ||
        // "(CMS)" closes a term, so the next term-level line starts a new one
        (/\([A-Z][A-Za-z0-9&\/+\- ]{1,14}\)$/.test(current.term.trim()) && /^[A-Z]/.test(left)) ||
        (/[.;:)”"]$/.test(prev.trim()) && /^[A-Z0-9“"(]/.test(left) && prev.trim().length > 0);
      if (startsNew) {
        current = { term: left, chunks: [], termOpen: true };
        entries.push(current);
      } else {
        current!.term += " " + left;
      }
      appendChunk(current!, page, right);
    }
    prevWasTermLevel = true;
  }
  for (const e of entries) e.term = e.term.replace(/\s+/g, " ").replace(/-\s+(?=\S)/g, "-").trim();
  return { entries, preamble };
}

function splitNearColumn(text: string, col: number): [string, string] | null {
  let best = -1;
  for (let p = Math.max(1, col - 4); p <= Math.min(text.length - 1, col + 2); p++) {
    if (text[p - 1] === " " && text[p] !== " ") {
      if (best < 0 || Math.abs(p - col) < Math.abs(best - col)) best = p;
    }
  }
  if (best < 0) return null;
  const left = text.slice(0, best).trim();
  if (!left) return null;
  return [left, text.slice(best).trim()];
}

function parseColonGlossary(lines: Line[]): { entries: GlossaryEntry[]; preamble: Line[] } {
  const entries: GlossaryEntry[] = [];
  const preamble: Line[] = [];
  const paragraphs: Line[][] = [];
  let cur: Line[] = [];
  for (const l of lines) {
    if (!l.text.trim()) {
      if (cur.length) paragraphs.push(cur);
      cur = [];
    } else cur.push(l);
  }
  if (cur.length) paragraphs.push(cur);

  const START = /^\s*([A-Z0-9“"(][^:]{0,80}):\s+(\S.*)$/;
  let current: GlossaryEntry | null = null;
  for (const para of paragraphs) {
    const m = para[0].text.match(START);
    if (m && indentOf(para[0].text) <= 4) {
      current = { term: m[1].trim(), chunks: [], termOpen: false };
      entries.push(current);
      appendChunk(current, para[0].page, cleanInner(m[2].trim()));
      for (const l of para.slice(1)) appendChunk(current, l.page, cleanInner(l.text.trim()));
    } else if (current) {
      for (const l of para) appendChunk(current, l.page, cleanInner(l.text.trim()));
    } else {
      preamble.push(...para);
    }
  }
  return { entries, preamble };
}

// ---------------------------------------------------------------- assembly

export function parsePolicy(file: string, folder: string): Policy {
  const fileName = path.basename(file);
  const fileId = fileName.split("_")[0].replace(/\.pdf$/i, "");
  const pages = pdfToPages(file).map(dropPolicyFooter);
  const lines: Line[] = [];
  pages.forEach((pl, i) => pl.forEach((text) => lines.push({ text: text.replace(/\s+$/, ""), page: i + 1 })));

  const warnings: string[] = [];
  const { header, sections } = splitSections(lines);
  const head = parseHeader(header.map((l) => l.text), fileName);
  if (head.id !== fileId) warnings.push(`header id "${head.id}" differs from file id "${fileId}"`);
  if (!sections.length) warnings.push("no sections found");

  const blocks: Block[] = [];
  const outline: Policy["outline"] = [];
  const outlineIndex = new Map<string, number>();
  const touch = (address: string, firstLine: string, page: number) => {
    const i = outlineIndex.get(address);
    if (i === undefined) {
      outlineIndex.set(address, outline.length);
      outline.push({ address, firstLine: firstLine.slice(0, 160), pageStart: page, pageEnd: page });
    } else {
      outline[i].pageEnd = Math.max(outline[i].pageEnd, page);
      outline[i].pageStart = Math.min(outline[i].pageStart, page);
    }
  };

  const programs = [
    head.programs.mediCal && "Medi-Cal",
    head.programs.oneCare && "OneCare",
    head.programs.pace && "PACE",
    head.programs.administrative && "Administrative",
  ].filter(Boolean);
  const headerLine = `[[${fileId} | ${head.title} | Applies to: ${programs.join(", ") || "none listed"} | Revised ${isoToUs(head.revisedDate)}]]`;

  let referencesText = "";
  for (const sec of sections) {
    if (sec.kind === "admin") continue;
    const kind = sec.kind;
    blocks.push({ text: `${sec.roman}. ${sec.title}`, page: sec.page, address: sec.roman, kind, scope: "both" });
    touch(sec.roman, `${sec.roman}. ${sec.title}`, sec.page);

    if (kind === "glossary") {
      const isTable = sec.lines.some((l) => TERM_HEADER.test(l.text));
      const { entries, preamble } = isTable ? parseTableGlossary(sec.lines) : parseColonGlossary(sec.lines);
      for (const l of preamble) {
        blocks.push({ text: cleanInner(l.text.trim()), page: l.page, address: sec.roman, kind, scope: "both" });
      }
      for (const e of entries) {
        const address = `Glossary: ${e.term}`;
        if (!e.chunks.length) e.chunks.push({ page: sec.page, text: "" });
        e.chunks.forEach((c, i) => {
          const text = i === 0 ? `${e.term}: ${c.text}` : c.text;
          blocks.push({ text, page: c.page, address, kind, scope: "both" });
          touch(address, `${e.term}: ${e.chunks[0].text}`, c.page);
        });
      }
      continue;
    }

    const { lines: outLines, items } = parseOutline(sec);
    if (kind === "body") assignScopes(items); // reference lists are never program-scoped
    for (const l of outLines) {
      const indent = "  ".repeat(Math.max(0, l.depth - 1));
      blocks.push({ text: indent + l.text, page: l.page, address: l.item.address, kind, scope: l.item.scope });
      touch(l.item.address, l.text, l.page);
    }
    if (kind === "references") referencesText += sec.lines.map((l) => l.text).join(" ") + " ";
  }

  const referencedApls = [
    ...new Set([...referencesText.replace(/\s+/g, " ").matchAll(/APL\)?\s*(\d{2}-\d{3})/g)].map((m) => m[1])),
  ].sort();

  // Canonical text + spans
  let text = headerLine + "\n";
  const spans: Policy["spans"] = [];
  let page = 0;
  for (const b of blocks) {
    if (b.page !== page) {
      page = b.page;
      text += `<<page ${page}>>\n`;
    }
    const start = text.length;
    text += b.text;
    const prev = spans[spans.length - 1];
    // consecutive lines of the same item on the same page share one span
    if (prev && prev.end === start - 1 && prev.page === b.page && prev.address === b.address && prev.kind === b.kind && prev.scope === b.scope) {
      prev.end = text.length;
    } else {
      spans.push({ start, end: text.length, page: b.page, address: b.address, kind: b.kind, scope: b.scope });
    }
    text += "\n";
  }

  return {
    id: fileId,
    title: head.title,
    department: head.department,
    section: head.section,
    effectiveDate: head.effectiveDate,
    revisedDate: head.revisedDate,
    programs: head.programs,
    pageCount: pages.length,
    referencedApls,
    canonicalText: text,
    tokenEstimate: estimateTokens(text),
    spans,
    outline,
    folder,
    sourceFile: fileName,
    warnings,
  };
}

export function listPolicyFiles(policiesDir: string): { file: string; folder: string }[] {
  const out: { file: string; folder: string }[] = [];
  for (const folder of fs.readdirSync(policiesDir).sort()) {
    const dir = path.join(policiesDir, folder);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.toLowerCase().endsWith(".pdf")) out.push({ file: path.join(dir, f), folder });
    }
  }
  return out;
}
