// Exact and keyword search over the prepared policies (ARCHITECTURE.md §7.3).
// Neither search decides an answer. They find candidates and back up "not found".
import MiniSearch from "minisearch";
import { SEARCH_OPTIONS, type SearchDoc } from "./searchOptions";
import { normalize, normalizeNumbers, searchableWithMap } from "./text";
import type { Policy, Scope, SpanKind } from "../types";

export type ExactHit = { policyId: string; address: string; page: number; kind: SpanKind; scope: Scope; snippet: string };
export type KeywordHit = { policyId: string; address: string; page: number; kind: SpanKind; score: number };

export type Search = {
  /** Every place an exact phrase occurs. "five calendar days" also finds "five (5) calendar days". */
  exactSearch(phrase: string, opts?: { mediCalOnly?: boolean; maxPerPolicy?: number }): ExactHit[];
  /** Best-matching passages for a free-text query, Medi-Cal policies only. */
  keywordSearch(query: string, k: number, opts?: { policyId?: string }): KeywordHit[];
  /** The policies with the best-matching passages, best first. */
  topPolicies(query: string, n: number): { policyId: string; score: number; best: KeywordHit }[];
};

type Prepared = { text: string; map: number[] };

export function createSearch(policies: Policy[], indexJson: string | null): Search {
  const prepared = new Map<string, Prepared>();
  const prep = (p: Policy): Prepared => {
    let x = prepared.get(p.id);
    if (!x) {
      x = searchableWithMap(p.canonicalText);
      prepared.set(p.id, x);
    }
    return x;
  };
  const spanAt = (p: Policy, offset: number) => p.spans.find((s) => offset >= s.start && offset < s.end) ?? p.spans.find((s) => s.start > offset);

  const mini = indexJson ? MiniSearch.loadJSON<SearchDoc>(indexJson, SEARCH_OPTIONS) : null;

  const exactSearch: Search["exactSearch"] = (phrase, opts = {}) => {
    const needle = normalizeNumbers(normalize(phrase));
    const hits: ExactHit[] = [];
    if (needle.length < 2) return hits;
    const maxPerPolicy = opts.maxPerPolicy ?? 5;
    for (const p of policies) {
      if (opts.mediCalOnly && !p.programs.mediCal) continue;
      const { text, map } = prep(p);
      let found = 0;
      for (let at = text.indexOf(needle); at >= 0 && found < maxPerPolicy; at = text.indexOf(needle, at + needle.length)) {
        // whole words only: "0657" must not match inside "10657"
        const before = at > 0 ? text[at - 1] : " ";
        const after = at + needle.length < text.length ? text[at + needle.length] : " ";
        if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
        const span = spanAt(p, map[at]);
        if (!span) continue;
        const from = map[Math.max(0, at - 60)];
        const to = map[Math.min(text.length - 1, at + needle.length + 60)];
        hits.push({
          policyId: p.id,
          address: span.address,
          page: span.page,
          kind: span.kind,
          scope: span.scope,
          snippet: p.canonicalText.slice(from, to).replace(/<<page \d+>>/g, " ").replace(/\s+/g, " ").trim(),
        });
        found++;
      }
    }
    return hits;
  };

  const keywordSearch: Search["keywordSearch"] = (query, k, opts = {}) => {
    if (!mini) return [];
    const q = normalizeNumbers(query);
    const results = mini.search(q, opts.policyId ? { filter: (r) => r.policyId === opts.policyId } : undefined);
    return results.slice(0, k).map((r) => ({
      policyId: r.policyId as string,
      address: r.address as string,
      page: r.page as number,
      kind: r.kind as SpanKind,
      score: r.score,
    }));
  };

  const topPolicies: Search["topPolicies"] = (query, n) => {
    const seen = new Map<string, { policyId: string; score: number; best: KeywordHit }>();
    for (const hit of keywordSearch(query, 60)) {
      if (!seen.has(hit.policyId)) seen.set(hit.policyId, { policyId: hit.policyId, score: hit.score, best: hit });
    }
    return [...seen.values()].slice(0, n);
  };

  return { exactSearch, keywordSearch, topPolicies };
}
