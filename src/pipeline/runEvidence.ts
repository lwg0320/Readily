// Steps 8–15 for any set of requirements (ARCHITECTURE.md §8). The questionnaire and the
// Policy Guide both run through this: a "parent" is one question or one obligation.
import { PIPELINE } from "../config/pipeline";
import type { ModelKey } from "../config/models";
import type { LLM, UsageTracker } from "../llm/client";
import { LLMError } from "../llm/client";
import { documentsBlock, READING_SYSTEM, readerSchema, readerTask, reviewerSchema, reviewerTask, type ProposedAnswer } from "../llm/prompts/reading";
import { estimateTokens } from "../lib/text";
import type { Evidence, Flag, FoundBy, Item, ItemResult, ItemStatus, ParentResult, ReaderDraft, Regulator, ReviewDraft, SearchTrail } from "../types";
import { buildChunks, collectCandidates, excerptPolicy, foundByLog, usableTerm, type CandidateMap, type ChunkPolicy } from "./candidates";
import { checkItem, verifyEvidence, type CheckContext } from "./checks";
import { bundleItems } from "./grouping";
import type { Library } from "./library";
import type { OnProgress } from "./progress";
import { readEveryPolicy, type Screening } from "./readEveryPolicy";
import { buildParentResult, resolveSecondOpinion } from "./verdicts";

export type Parent = {
  id: string;
  /** How the prompt names it, e.g. "QUESTION 11" or "OBLIGATION". */
  label: string;
  text: string;
  items: Item[];
  /** Flags raised before the evidence steps (e.g. by the checklist). */
  flags: Flag[];
};

export type Group = { parents: Parent[]; regulatorText: string };

export type EvidenceRun = {
  results: ParentResult[];
  foundBy: { itemId: string; policyId: string; foundBy: FoundBy[] }[];
  stats: { items: number; bundles: number; policiesRead: number; screeningCalls: number; screeningHits: number; rescued: number; chunks: number };
};

export type EvidenceArgs = {
  groups: Group[];
  regulator: Regulator;
  library: Library;
  llm: LLM;
  models: { fullReading: ModelKey; secondOpinion: ModelKey };
  tracker?: UsageTracker;
  signal?: AbortSignal;
  onProgress?: OnProgress;
  /** Called as soon as a group is finished, so the UI can show results while the rest runs. */
  onGroupDone?: (results: ParentResult[]) => void;
};

/** What one item looks like after the full reading, checks and second opinion on one set of documents. */
type Outcome = { status: ItemStatus; evidence: Evidence[]; flags: Flag[]; readerReason: string; reviewer: ItemResult["reviewer"] };

const STATUS_RANK: Record<ItemStatus, number> = { conflict: 3, needs_review: 2, covered: 1, not_covered: 0 };

function dedupeFlags(flags: Flag[]): Flag[] {
  const seen = new Set<string>();
  return flags.filter((f) => {
    const k = `${f.code}|${f.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function dedupeEvidence(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return evidence.filter((e) => {
    const k = `${e.policyId}|${e.address}|${e.quote}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Combines the outcomes an item got from different sets of documents: the strongest status wins. */
export function mergeOutcomes(outcomes: Outcome[]): Outcome {
  if (!outcomes.length) {
    return { status: "not_covered", evidence: [], flags: [], readerReason: "No policy was identified as possibly relevant.", reviewer: null };
  }
  const top = Math.max(...outcomes.map((o) => STATUS_RANK[o.status]));
  const winners = outcomes.filter((o) => STATUS_RANK[o.status] === top);
  return {
    status: winners[0].status,
    evidence: dedupeEvidence(winners.flatMap((o) => o.evidence)),
    flags: dedupeFlags(winners.flatMap((o) => o.flags)),
    readerReason: winners.map((o) => o.readerReason).filter(Boolean)[0] ?? "",
    reviewer: winners.map((o) => o.reviewer).find(Boolean) ?? null,
  };
}

export async function runEvidence(args: EvidenceArgs): Promise<EvidenceRun> {
  const { groups, regulator, library, llm, models, tracker, signal, onProgress, onGroupDone } = args;
  const allItems = groups.flatMap((g) => g.parents.flatMap((p) => p.items));
  const bundleCount = Math.max(1, Math.min(PIPELINE.bundles, Math.ceil(allItems.length / PIPELINE.itemsPerBundle)));
  const bundles = bundleItems(allItems, bundleCount);

  // Step 9
  const screening = await readEveryPolicy({ bundles, policies: library.mediCal, llm, tracker, signal, onProgress });
  const screeningCalls = bundles.length * library.mediCal.length;

  // Step 10
  const candidates = collectCandidates(allItems, screening.hits, library.policies, library.search);

  const ctx: CheckContext = { policies: library.policies, regulator };
  const sameModel = models.fullReading === models.secondOpinion;
  let rescued = 0;
  let chunkCount = 0;
  let groupsDone = 0;

  // Steps 11–13 on one set of documents, for the given items of each parent.
  async function readAndReview(docs: ChunkPolicy[], group: Group, wanted: Map<string, Item[]>): Promise<Map<string, Outcome>> {
    const out = new Map<string, Outcome>();
    const parents = group.parents.filter((p) => wanted.get(p.id)?.length);
    if (!parents.length || !docs.length) return out;
    chunkCount++;
    const allowed = new Set(docs.map((d) => d.policyId));
    const localCtx: CheckContext = { ...ctx, policies: new Map([...ctx.policies].filter(([id]) => allowed.has(id))) };
    const prefix = { text: documentsBlock(docs, regulator.label, group.regulatorText), cache: true };
    const system = [{ text: READING_SYSTEM }];

    // Step 11 — full reading
    const readings = await llm.warmThenAll(
      parents.map((p) => () =>
        llm.call({ task: "fullReading", model: models.fullReading, system, user: [prefix, { text: readerTask(p, wanted.get(p.id)!) }], schema: readerSchema, tracker, signal }),
      ),
    );

    // Step 12 — automatic checks
    const proposed = new Map<string, ProposedAnswer[]>();
    const reasons = new Map<string, string>();
    parents.forEach((p, i) => {
      const r = readings[i];
      const items = wanted.get(p.id)!;
      if (r instanceof LLMError) {
        for (const item of items) {
          out.set(item.id, { status: "needs_review", evidence: [], flags: [{ code: "analysis_failed", detail: "Could not be analysed — retry." }], readerReason: "", reviewer: null });
        }
        return;
      }
      const drafts = new Map(r.data.items.map((d) => [d.itemId, d]));
      const list: ProposedAnswer[] = [];
      for (const item of items) {
        const draft: ReaderDraft = drafts.get(item.id) ?? { itemId: item.id, status: "not_covered", wording: "same", evidence: [], reason: "" };
        const checked = checkItem(item, draft, localCtx);
        reasons.set(item.id, draft.reason);
        list.push({ item, ...checked });
      }
      proposed.set(p.id, list);
    });

    // Step 13 — second opinion, right away so the cached documents are still live
    const reviewable = parents.filter((p) => proposed.has(p.id));
    const reviews = await llm.warmThenAll(
      reviewable.map((p) => () =>
        llm.call({ task: "secondOpinion", model: models.secondOpinion, system, user: [prefix, { text: reviewerTask(p, proposed.get(p.id)!) }], schema: reviewerSchema, tracker, signal }),
      ),
      { alreadyWarm: sameModel },
    );
    reviewable.forEach((p, i) => {
      const r = reviews[i];
      const byItem = r instanceof LLMError ? new Map<string, ReviewDraft>() : new Map(r.data.items.map((d) => [d.itemId, d as ReviewDraft]));
      for (const answer of proposed.get(p.id)!) {
        const review = byItem.get(answer.item.id) ?? null;
        const fresh = review ? verifyEvidence(answer.item, review.newEvidence, localCtx) : { evidence: [], flags: [] };
        const resolved = resolveSecondOpinion({ status: answer.status, evidence: answer.evidence, flags: answer.flags }, review, fresh.evidence);
        let { status } = resolved;
        const flags = [...resolved.flags, ...(resolved.evidence.length > answer.evidence.length ? fresh.flags : [])];
        if (!review && status === "covered") {
          // "Covered" requires a second opinion that agrees. Without one, a person decides.
          status = "needs_review";
          flags.push({ code: "analysis_failed", detail: "The second opinion could not be completed — retry." });
        }
        out.set(answer.item.id, { status, evidence: resolved.evidence, flags: dedupeFlags(flags), readerReason: reasons.get(answer.item.id) ?? "", reviewer: resolved.reviewer });
      }
    });
    return out;
  }

  async function processGroup(group: Group): Promise<ParentResult[]> {
    const items = group.parents.flatMap((p) => p.items);
    const itemsOf = (ids: Set<string>) => new Map(group.parents.map((p) => [p.id, p.items.filter((i) => ids.has(i.id))]));
    const { chunks, skipped } = buildChunks(items, candidates, library.policies, library.search);
    const read = new Set(chunks.flatMap((c) => c.policies.map((p) => p.policyId)));

    const outcomes = new Map<string, Outcome[]>(items.map((i) => [i.id, []]));
    const record = (m: Map<string, Outcome>) => m.forEach((o, id) => outcomes.get(id)?.push(o));

    // Every question is asked against every set of documents for its group: the reader may find
    // evidence for a requirement in a policy that was flagged for a neighbouring one.
    const everything = itemsOf(new Set(items.map((i) => i.id)));
    for (const chunk of chunks) record(await readAndReview(chunk.policies, group, everything));

    // Step 14 — before anything is called "not found"
    const unresolved = () => items.filter((i) => {
      const m = mergeOutcomes(outcomes.get(i.id)!);
      return m.status === "not_covered" && m.evidence.length === 0;
    });
    let open = unresolved();
    const skippedFor = new Map<string, string[]>();
    for (const s of skipped) for (const id of s.itemIds) skippedFor.set(id, [...(skippedFor.get(id) ?? []), s.policyId]);

    if (open.length) {
      // 14.1 every policy must really have been read for these items
      const late = (await Promise.all([...new Set(open.map((i) => screening.bundleOf.get(i.id)!))].map((b) => screening.retryMissing(b)))).flat();
      // 14.2 one more look: late reads, policies left out earlier, and the next keyword hits
      const votes = new Map<string, { n: number; addresses: string[]; queries: string[] }>();
      const vote = (policyId: string, address: string, query: string) => {
        if (read.has(policyId) || !library.policies.has(policyId)) return;
        const v = votes.get(policyId) ?? { n: 0, addresses: [], queries: [] };
        v.n++;
        if (address) v.addresses.push(address);
        v.queries.push(query);
        votes.set(policyId, v);
      };
      const openIds = new Set(open.map((i) => i.id));
      for (const h of late) if (openIds.has(h.itemId)) vote(h.policyId, h.address, "");
      for (const item of open) {
        for (const id of skippedFor.get(item.id) ?? []) vote(id, "", item.requirement);
        for (const top of library.search.topPolicies(item.requirement, PIPELINE.rescueKeywordHits)) vote(top.policyId, top.best.address, item.requirement);
      }
      const docs: ChunkPolicy[] = [];
      let used = 0;
      for (const [policyId, v] of [...votes].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))) {
        const policy = library.policies.get(policyId)!;
        const long = policy.tokenEstimate > PIPELINE.longPolicyTokens;
        const text = long ? excerptPolicy(policy, v.addresses, v.queries.filter(Boolean), library.search, Math.floor(PIPELINE.maxPolicyTokensPerCall * 0.4)) : policy.canonicalText;
        const tokens = estimateTokens(text);
        if (used + tokens > PIPELINE.maxPolicyTokensPerCall) continue;
        docs.push({ policyId, mode: long ? "excerpt" : "full", text, tokens });
        used += tokens;
        read.add(policyId);
      }
      if (docs.length) {
        const before = open.length;
        record(await readAndReview(docs, group, itemsOf(openIds)));
        open = unresolved();
        rescued += before - open.length;
      }
    }

    // 14.3 the search trail for what is still not found
    const trails = new Map<string, SearchTrail>();
    for (const item of open) {
      const exactTerms = item.searchTerms
        .map((raw) => usableTerm(raw, item.requirement))
        .filter((t): t is string => !!t)
        .map((term) => ({ term, hits: new Set(library.search.exactSearch(term, { mediCalOnly: true, maxPerPolicy: 1 }).map((h) => h.policyId)).size }));
      const top = library.search.topPolicies(item.requirement, 1)[0];
      trails.set(item.id, {
        policiesRead: screening.completed.get(screening.bundleOf.get(item.id)!)?.size ?? 0,
        exactTerms,
        closest: top ? { policyId: top.policyId, title: library.policies.get(top.policyId)?.title ?? "", address: top.best.address, page: top.best.page } : null,
        skippedCandidates: (skippedFor.get(item.id) ?? []).filter((id) => !read.has(id)),
      });
    }

    // Step 15
    return group.parents.map((p) => {
      const results: ItemResult[] = p.items.map((item) => ({ item, ...mergeOutcomes(outcomes.get(item.id)!), trail: trails.get(item.id) }));
      if (p.flags.length && results.length) results[0] = { ...results[0], flags: dedupeFlags([...p.flags, ...results[0].flags]) };
      return buildParentResult(p.id, results);
    });
  }

  const perGroup = await Promise.all(
    groups.map(async (g) => {
      const results = await processGroup(g);
      onProgress?.({ stage: "reading", done: ++groupsDone, total: groups.length });
      onGroupDone?.(results);
      return results;
    }),
  );
  onProgress?.({ stage: "done" });

  return {
    results: perGroup.flat(),
    foundBy: foundByLog(candidates as CandidateMap),
    stats: {
      items: allItems.length,
      bundles: bundles.length,
      policiesRead: library.mediCal.length,
      screeningCalls,
      screeningHits: screening.hits.length,
      rescued,
      chunks: chunkCount,
    },
  };
}

export type { Screening };
