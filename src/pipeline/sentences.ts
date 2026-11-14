// Splitting a Policy Guide section into numbered sentences (ARCHITECTURE.md Step 22).
// Plain code: an obligation's source text and page come from these sentences, so they are
// exact by construction, and every sentence that sounds like a duty can be accounted for.
import type { GuideSection } from "../types";

export type Sentence = {
  /** "S1", "S2", … in reading order. */
  id: string;
  text: string;
  page: number;
  /** Paragraph number within the section. */
  block: number;
  /** The paragraph is a » bullet. */
  bullet: boolean;
  /** Part of the "Footnotes:" block at the end of the section. */
  footnote: boolean;
  /** Sounds like a duty: must, shall, required, should, encouraged, expected… */
  cue: boolean;
};

const CUE = /\b(must|shall|required|requires|may not|must not|should|encouraged|expected to|are expected|is expected)\b/i;
const ABBREVIATION = /(?:\b(?:e\.g|i\.e|etc|vs|cf|U\.S|Dr|Mr|Ms|Mrs|No|Sec|Inc|approx)\.|\b[A-Z]\.)$/;

/** Sentence ends: a full stop, question mark or semicolon (with an optional footnote number), then a capital. */
function splitBlock(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const end = /([.?!](?:["”)])?\d{0,3}|;)\s+(?=["“(]?[A-Z])/g;
  for (let m = end.exec(text); m; m = end.exec(text)) {
    const candidate = text.slice(start, m.index + m[1].length);
    if (ABBREVIATION.test(candidate.replace(/\d{1,3}$/, ""))) continue;
    out.push(candidate.trim());
    start = m.index + m[0].length;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  // a fragment such as a list number ("1.") belongs to what follows
  const merged: string[] = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && prev.split(/\s+/).length < 3) merged[merged.length - 1] = `${prev} ${s}`;
    else merged.push(s);
  }
  return merged;
}

export function splitSentences(section: Pick<GuideSection, "text" | "pageStart">): Sentence[] {
  type Block = { text: string; page: number; bullet: boolean; footnote: boolean };
  const blocks: Block[] = [];
  let page = section.pageStart;
  let open: Block | null = null;
  let inFootnotes = false;
  const close = () => {
    if (open && open.text.trim()) blocks.push(open);
    open = null;
  };

  for (const raw of section.text.split("\n")) {
    const line = raw.trim();
    const marker = line.match(/^<<page (\d+)>>$/);
    if (marker) {
      page = Number(marker[1]); // a page break does not end a sentence
      continue;
    }
    if (!line) {
      close();
      continue;
    }
    if (line === "Footnotes:") {
      close();
      inFootnotes = true;
      continue;
    }
    const footnote = inFootnotes ? line.match(/^\[Footnote \d+, p\.(\d+)\]/) : null;
    const bullet = /^[»•]\s*/.test(line);
    if (footnote || bullet) close();
    if (!open) open = { text: "", page: footnote ? Number(footnote[1]) : page, bullet, footnote: inFootnotes };
    const piece = line.replace(/^[»•]\s*/, "");
    // "long-" + "term" was one word broken across lines
    open.text = /[a-z]-$/.test(open.text) && /^[a-z]/.test(piece) ? open.text + piece : open.text ? `${open.text} ${piece}` : piece;
  }
  close();

  const sentences: Sentence[] = [];
  blocks.forEach((b, block) => {
    for (const text of b.footnote ? [b.text] : splitBlock(b.text)) {
      sentences.push({ id: `S${sentences.length + 1}`, text, page: b.page, block, bullet: b.bullet, footnote: b.footnote, cue: CUE.test(text) });
    }
  });
  return sentences;
}
