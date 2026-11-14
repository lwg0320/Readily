// Quote verification (ARCHITECTURE.md §7.2): a quote only counts if it is really in the policy.
import { normalize, normalizeWithMap } from "./text";
import type { Policy, PolicySpan } from "../types";

export type VerifiedQuote =
  | { status: "rejected" }
  | {
      status: "exact" | "corrected";
      /** The policy's own words for the matched range (never the model's wording). */
      text: string;
      page: number;
      address: string;
      kind: PolicySpan["kind"];
      scope: PolicySpan["scope"];
      start: number;
      end: number;
    };

type Prepared = { text: string; map: number[]; tokens: { t: string; at: number; len: number }[] };

/** A word without the punctuation around it, so "services." and "services" compare equal. */
function bare(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || token;
}
const cache = new WeakMap<Policy, Prepared>();

function prepare(policy: Policy): Prepared {
  let p = cache.get(policy);
  if (!p) {
    const { text, map } = normalizeWithMap(policy.canonicalText);
    const tokens: Prepared["tokens"] = [];
    for (const m of text.matchAll(/\S+/g)) tokens.push({ t: bare(m[0]), at: m.index!, len: m[0].length });
    p = { text, map, tokens };
    cache.set(policy, p);
  }
  return p;
}

function spanAt(policy: Policy, offset: number): PolicySpan | undefined {
  const spans = policy.spans;
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offset < spans[mid].start) hi = mid - 1;
    else if (offset >= spans[mid].end) lo = mid + 1;
    else return spans[mid];
  }
  // between two spans (a newline or page marker): take the next span
  return spans[Math.min(lo, spans.length - 1)];
}

function result(policy: Policy, prep: Prepared, nStart: number, nEnd: number, status: "exact" | "corrected"): VerifiedQuote {
  const start = prep.map[nStart];
  const end = prep.map[nEnd - 1] + 1;
  const span = spanAt(policy, start);
  if (!span) return { status: "rejected" };
  const text = policy.canonicalText
    .slice(start, end)
    .replace(/<<page \d+>>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { status, text, page: span.page, address: span.address, kind: span.kind, scope: span.scope, start, end };
}

/** Evidence that can be cited is preferred when the same words occur in several places. */
function rank(v: VerifiedQuote): number {
  if (v.status === "rejected") return 9;
  if (v.scope === "other") return 3;
  if (v.kind === "references") return 2;
  return 0;
}

function levenshtein(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const MIN_CHARS = 8;
const SIMILARITY = 0.9;

export function cleanQuote(quote: string): string {
  return quote
    .trim()
    .replace(/^["“”'‘’\s]+|["“”'‘’\s]+$/g, "")
    .replace(/^(\.\.\.|…)\s*|\s*(\.\.\.|…)$/g, "");
}

export function verifyQuote(policy: Policy, quote: string): VerifiedQuote {
  const prep = prepare(policy);
  const q = normalize(cleanQuote(quote));
  if (q.length < MIN_CHARS) return { status: "rejected" };

  // 1. exact (after normalization). Prefer an occurrence that can be cited.
  let best: VerifiedQuote = { status: "rejected" };
  for (let at = prep.text.indexOf(q); at >= 0; at = prep.text.indexOf(q, at + 1)) {
    const r = result(policy, prep, at, at + q.length, "exact");
    if (rank(r) < rank(best)) best = r;
    if (rank(best) === 0) break;
  }
  if (best.status !== "rejected") return best;

  // 2. near miss: find the window of policy text most similar to the quote
  const qt = q.split(" ").map(bare);
  const n = qt.length;
  if (n < 5) return { status: "rejected" };
  const k = Math.min(5, n);
  const starts = new Set<number>();
  const tokens = prep.tokens;
  for (let i = 0; i + k <= n && starts.size < 12; i++) {
    const shingle = qt.slice(i, i + k);
    for (let j = 0; j + k <= tokens.length; j++) {
      let ok = true;
      for (let x = 0; x < k; x++) {
        if (tokens[j + x].t !== shingle[x]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        starts.add(Math.max(0, j - i));
        if (starts.size >= 12) break;
      }
    }
  }
  const slack = Math.ceil(n * 0.2);
  let bestSim = 0;
  let bestRange: [number, number] | null = null;
  for (const s0 of starts) {
    for (let s = Math.max(0, s0 - 2); s <= s0 + 2 && s < tokens.length; s++) {
      for (let len = Math.max(3, n - slack); len <= n + slack && s + len <= tokens.length; len++) {
        const window = tokens.slice(s, s + len).map((x) => x.t);
        const sim = 1 - levenshtein(qt, window) / Math.max(n, len);
        if (sim > bestSim) {
          bestSim = sim;
          bestRange = [s, s + len];
        }
      }
    }
  }
  if (bestRange && bestSim >= SIMILARITY) {
    const first = tokens[bestRange[0]];
    const last = tokens[bestRange[1] - 1];
    return result(policy, prep, first.at, last.at + last.len, "corrected");
  }
  return { status: "rejected" };
}
