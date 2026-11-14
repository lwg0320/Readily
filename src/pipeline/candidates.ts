// Step 10 — combine candidates (ARCHITECTURE.md §8). Plain code.
// A policy is read in full for an item if ANY layer points to it: the Step 9 reader, an exact
// search hit, or a top keyword hit.
import { PIPELINE } from "../config/pipeline";
import type { Search } from "../lib/search";
import { estimateTokens, normalize } from "../lib/text";
import type { FoundBy, Item, Policy } from "../types";

export type ScreeningHit = { policyId: string; itemId: string; address: string; strength: "direct" | "maybe" };

/** `strong`: the Step 9 reader called it direct, or a rare exact term was found in it. Strong candidates are always read in full. */
export type Candidate = { foundBy: Set<FoundBy>; addresses: Set<string>; strong: boolean };
/** itemId → policyId → how it was found */
export type CandidateMap = Map<string, Map<string, Candidate>>;

export type ChunkPolicy = { policyId: string; mode: "full" | "excerpt"; text: string; tokens: number };
export type Chunk = { index: number; policies: ChunkPolicy[]; tokens: number; itemIds: string[] };
/** `skipped`: weaker candidates that did not fit. Step 14 reads them before an item is called "not found". */
export type GroupCandidates = { chunks: Chunk[]; skipped: { policyId: string; itemIds: string[] }[] };

type Config = Pick<typeof PIPELINE, "maxPolicyTokensPerCall" | "longPolicyTokens" | "keywordHitsPerItem" | "commonTermPolicies" | "rareTermPolicies">;

function add(map: CandidateMap, itemId: string, policyId: string, by: FoundBy, strong: boolean, address?: string) {
  let perItem = map.get(itemId);
  if (!perItem) map.set(itemId, (perItem = new Map()));
  let c = perItem.get(policyId);
  if (!c) perItem.set(policyId, (c = { foundBy: new Set(), addresses: new Set(), strong: false }));
  c.foundBy.add(by);
  if (strong) c.strong = true;
  if (address) c.addresses.add(address);
}

/** Very short search terms ("900") are only searched together with the word that follows them. */
export function usableTerm(term: string, requirement: string): string | null {
  const t = term.trim();
  if (t.length >= 4) return t;
  if (!t) return null;
  const m = requirement.match(new RegExp(`(?:^|[^A-Za-z0-9])(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^A-Za-z0-9]{1,3}[A-Za-z0-9]+)`, "i"));
  return m ? m[1] : null;
}

export function collectCandidates(
  items: Item[],
  hits: ScreeningHit[],
  policies: Map<string, Policy>,
  search: Search,
  cfg: Config = PIPELINE,
): CandidateMap {
  const map: CandidateMap = new Map();
  const itemIds = new Set(items.map((i) => i.id));

  for (const h of hits) {
    const p = policies.get(h.policyId);
    if (!p || !p.programs.mediCal || !itemIds.has(h.itemId)) continue;
    add(map, h.itemId, h.policyId, h.strength === "direct" ? "haiku-direct" : "haiku-maybe", h.strength === "direct", h.address);
  }

  for (const item of items) {
    for (const raw of item.searchTerms) {
      const term = usableTerm(raw, item.requirement);
      if (!term) continue;
      const found = search
        .exactSearch(term, { mediCalOnly: true, maxPerPolicy: 3 })
        .filter((h) => h.scope !== "other" && (h.kind !== "references" || item.allowsReference));
      const distinct = new Set(found.map((h) => h.policyId));
      if (distinct.size > cfg.commonTermPolicies) continue; // too common to point anywhere
      // a term only a handful of policies contain is a strong pointer; a more widespread one is a hint
      const rare = distinct.size <= cfg.rareTermPolicies;
      for (const h of found) add(map, item.id, h.policyId, "exact", rare, h.address);
    }
    for (const top of search.topPolicies(item.requirement, cfg.keywordHitsPerItem)) {
      const p = policies.get(top.policyId);
      if (!p || !p.programs.mediCal) continue;
      add(map, item.id, top.policyId, "keyword", false, top.best.address);
    }
  }
  return map;
}

// ------------------------------------------------------------------ excerpts of long policies

function resolveRoot(policy: Policy, address: string, addresses: Set<string>): string | null {
  const g = address.match(/glossary\s*[:\-–]?\s*(.+)$/i);
  if (g) {
    const want = normalize(g[1].replace(/^["“']|["”']$/g, ""));
    for (const a of addresses) if (a.startsWith("Glossary: ") && normalize(a.slice(10)) === want) return a;
    for (const a of addresses) if (a.startsWith("Glossary: ") && normalize(a.slice(10)).startsWith(want)) return a;
    return null;
  }
  const m = address.match(/\b([IVX]{1,4}(?:\.[A-Za-z0-9]{1,3})*)\b/);
  if (!m) return null;
  const segs = m[1].split(".");
  for (let n = Math.min(2, segs.length); n >= 1; n--) {
    const root = segs.slice(0, n).join(".");
    if (addresses.has(root) || [...addresses].some((a) => a.startsWith(root + "."))) return root;
  }
  return null;
}

/**
 * For a policy too long to send whole: its header line plus the lettered sections and glossary
 * entries that were pointed to. Text is copied unchanged, so quotes still verify.
 */
export function excerptPolicy(policy: Policy, hitAddresses: string[], fallbackQueries: string[], search: Search, maxTokens: number): string {
  const all = new Set(policy.spans.map((s) => s.address));
  const roots = new Set<string>();
  for (const a of hitAddresses) {
    const r = resolveRoot(policy, a, all);
    if (r) roots.add(r);
  }
  if (!roots.size) {
    for (const q of fallbackQueries) {
      for (const h of search.keywordSearch(q, 3, { policyId: policy.id })) {
        const r = resolveRoot(policy, h.address, all);
        if (r) roots.add(r);
      }
    }
  }
  const header = policy.canonicalText.split("\n", 1)[0];
  let out = `${header}\n(Excerpts from a long document: only the sections that may be relevant are shown.)\n`;
  let page = 0;
  let used = estimateTokens(out);
  for (const s of policy.spans) {
    const inRoot = [...roots].some((r) => s.address === r || (!r.startsWith("Glossary: ") && s.address.startsWith(r + ".")));
    if (!inRoot) continue;
    const text = policy.canonicalText.slice(s.start, s.end);
    const cost = estimateTokens(text) + 4;
    if (used + cost > maxTokens) break;
    if (s.page !== page) {
      page = s.page;
      out += `<<page ${page}>>\n`;
    }
    out += text + "\n";
    used += cost;
  }
  return out;
}

// ------------------------------------------------------------------ packing into calls

const SCORE: Record<FoundBy, number> = { "haiku-direct": 3, exact: 1, "haiku-maybe": 1, keyword: 1 };

/**
 * Decides which policies are read in full for a group, and packs them into calls.
 * - Strong candidates are always read, however many calls that takes.
 * - Weaker ones (a "maybe", a widespread exact term, a keyword hit) only fill the room left in
 *   those calls. If there are no strong candidates at all, the best weaker ones share one call.
 * - Whatever is left over is returned as `skipped`.
 */
export function buildChunks(
  groupItems: Item[],
  candidates: CandidateMap,
  policies: Map<string, Policy>,
  search: Search,
  cfg: Config = PIPELINE,
): GroupCandidates {
  type Row = { policy: Policy; score: number; required: boolean; itemIds: string[]; addresses: string[]; queries: string[] };
  const rows = new Map<string, Row>();
  for (const item of groupItems) {
    for (const [policyId, c] of candidates.get(item.id) ?? []) {
      const policy = policies.get(policyId);
      if (!policy) continue;
      let row = rows.get(policyId);
      if (!row) rows.set(policyId, (row = { policy, score: 0, required: false, itemIds: [], addresses: [], queries: [] }));
      for (const by of c.foundBy) row.score += SCORE[by];
      if (c.strong) {
        row.required = true;
        row.score += 2;
      }
      row.itemIds.push(item.id);
      row.addresses.push(...c.addresses);
      row.queries.push(item.requirement);
    }
  }

  const ordered = [...rows.values()].sort(
    (a, b) => Number(b.required) - Number(a.required) || b.score - a.score || a.policy.id.localeCompare(b.policy.id),
  );
  const anyRequired = ordered.some((r) => r.required);

  const chunks: (Chunk & { items: Set<string> })[] = [];
  const skipped: GroupCandidates["skipped"] = [];
  for (const row of ordered) {
    const long = row.policy.tokenEstimate > cfg.longPolicyTokens;
    const text = long
      ? excerptPolicy(row.policy, row.addresses, row.queries, search, Math.floor(cfg.maxPolicyTokensPerCall * 0.8))
      : row.policy.canonicalText;
    const tokens = estimateTokens(text);
    let target = chunks.find((c) => c.tokens + tokens <= cfg.maxPolicyTokensPerCall);
    if (!target) {
      const mayOpenCall = row.required || (!anyRequired && chunks.length === 0);
      if (!mayOpenCall) {
        skipped.push({ policyId: row.policy.id, itemIds: row.itemIds });
        continue;
      }
      target = { index: chunks.length, policies: [], tokens: 0, itemIds: [], items: new Set() };
      chunks.push(target);
    }
    target.policies.push({ policyId: row.policy.id, mode: long ? "excerpt" : "full", text, tokens });
    target.tokens += tokens;
    for (const id of row.itemIds) target.items.add(id);
  }

  const order = new Map(groupItems.map((it, i) => [it.id, i]));
  return {
    chunks: chunks.map(({ items, ...c }) => ({ ...c, itemIds: [...items].sort((a, b) => order.get(a)! - order.get(b)!) })),
    skipped,
  };
}

/** For the accuracy page: which layer found each policy for each item. */
export type FoundByEntry = { itemId: string; policyId: string; foundBy: FoundBy[]; strong: boolean };

export function foundByLog(candidates: CandidateMap): FoundByEntry[] {
  const out: FoundByEntry[] = [];
  for (const [itemId, perItem] of candidates) {
    for (const [policyId, c] of perItem) out.push({ itemId, policyId, foundBy: [...c.foundBy], strong: c.strong });
  }
  return out;
}
