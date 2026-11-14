// Shared text utilities (ARCHITECTURE.md §7.1). Used by the prep scripts and the app.

export type Quantity = { value: number; unit: string; unitBase: string };

const PAGE_MARKER = /<<page \d+>>/g;

const CHAR_MAP: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
  " ": " ", " ": " ", " ": " ", "­": "",
};

function isAlnum(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Normalizes text for matching: removes page markers, straightens quotes and dashes,
 * joins words hyphenated across a line break, collapses whitespace, lower-cases.
 * `map[i]` is the offset in the original string of normalized character i.
 */
export function normalizeWithMap(s: string): { text: string; map: number[] } {
  const skip: [number, number][] = [];
  for (const m of s.matchAll(PAGE_MARKER)) skip.push([m.index!, m.index! + m[0].length]);
  let skipIdx = 0;

  const out: string[] = [];
  const map: number[] = [];
  const pushSpace = (i: number) => {
    const n = out.length;
    if (n === 0 || out[n - 1] === " ") return;
    // "Medi-\nCal" -> "medi-cal": drop whitespace that follows a hyphen attached to a word.
    if (out[n - 1] === "-" && n >= 2 && isAlnum(out[n - 2])) return;
    out.push(" ");
    map.push(i);
  };

  for (let i = 0; i < s.length; i++) {
    while (skipIdx < skip.length && i >= skip[skipIdx][1]) skipIdx++;
    if (skipIdx < skip.length && i >= skip[skipIdx][0]) {
      pushSpace(i);
      i = skip[skipIdx][1] - 1;
      continue;
    }
    let ch = s[i];
    if (ch in CHAR_MAP) ch = CHAR_MAP[ch];
    if (ch === "") continue;
    if (/\s/.test(ch)) {
      pushSpace(i);
      continue;
    }
    for (const c of ch.toLowerCase()) {
      out.push(c);
      map.push(i);
    }
  }
  while (out.length && out[out.length - 1] === " ") {
    out.pop();
    map.pop();
  }
  return { text: out.join(""), map };
}

export function normalize(s: string): string {
  return normalizeWithMap(s).text;
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const NUM_WORD = `(?:${[...Object.keys(UNITS), ...Object.keys(TENS), "hundred"].join("|")})`;
const NUM_SEQ = new RegExp(`\\b${NUM_WORD}(?:(?:[\\s-]+|\\s+and\\s+)${NUM_WORD})*\\b`, "gi");

function wordsToNumber(seq: string): number | null {
  const words = seq.toLowerCase().split(/[\s-]+/).filter((w) => w && w !== "and");
  let total = 0;
  let current = 0;
  for (const w of words) {
    if (w in UNITS) current += UNITS[w];
    else if (w in TENS) current += TENS[w];
    else if (w === "hundred") current = (current || 1) * 100;
    else return null;
  }
  total += current;
  return total;
}

type Mapped = { text: string; map: number[] };

/** Regex replace that keeps, for every output character, the offset it came from. */
function replaceMapped(input: Mapped, re: RegExp, fn: (m: RegExpMatchArray) => string | null): Mapped {
  const out: string[] = [];
  const map: number[] = [];
  let last = 0;
  for (const m of input.text.matchAll(re)) {
    const rep = fn(m);
    if (rep === null) continue;
    const at = m.index!;
    for (let i = last; i < at; i++) {
      out.push(input.text[i]);
      map.push(input.map[i]);
    }
    for (const c of rep) {
      out.push(c);
      map.push(input.map[at]);
    }
    last = at + m[0].length;
  }
  for (let i = last; i < input.text.length; i++) {
    out.push(input.text[i]);
    map.push(input.map[i]);
  }
  return { text: out.join(""), map };
}

/**
 * "five (5) calendar days" and "five calendar days" both become "5 calendar days".
 * Applied to both sides of a comparison, never to text shown to the user.
 * `map` carries offsets through, so a match can be traced back to the original text.
 */
export function normalizeNumbersWithMap(input: Mapped): Mapped {
  let t = replaceMapped(input, NUM_SEQ, (m) => {
    const n = wordsToNumber(m[0]);
    return n === null ? null : String(n);
  });
  t = replaceMapped(t, /(\d+)\s*\(\s*(\d+)\s*\)/g, (m) => (m[1] === m[2] ? m[1] : null));
  t = replaceMapped(t, /(\d)\s*%/g, (m) => `${m[1]} percent`);
  t = replaceMapped(t, /\bper cent\b/gi, () => "percent");
  return t;
}

export function normalizeNumbers(s: string): string {
  return normalizeNumbersWithMap({ text: s, map: Array.from({ length: s.length }, (_, i) => i) }).text;
}

/** Lower-cased, whitespace-collapsed, number-normalized text for searching, with offsets back to `s`. */
export function searchableWithMap(s: string): Mapped {
  return normalizeNumbersWithMap(normalizeWithMap(s));
}

const UNIT_RE =
  /(\d+(?:\.\d+)?)\s*-?\s*(calendar days?|business days?|working days?|days?|hours?|months?|years?|percent|visits?)\b/gi;

function unitBaseOf(unit: string): string {
  const u = unit.toLowerCase();
  if (u.includes("day")) return "day";
  if (u.startsWith("hour")) return "hour";
  if (u.startsWith("month")) return "month";
  if (u.startsWith("year")) return "year";
  if (u.startsWith("visit")) return "visit";
  return "percent";
}

export function extractQuantities(s: string): Quantity[] {
  const t = normalizeNumbers(normalize(s));
  const out: Quantity[] = [];
  for (const m of t.matchAll(UNIT_RE)) {
    const unit = m[2].toLowerCase().replace(/s$/, "");
    out.push({ value: Number(m[1]), unit, unitBase: unitBaseOf(unit) });
  }
  return out;
}

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
