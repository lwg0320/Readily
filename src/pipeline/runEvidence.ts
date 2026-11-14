// Steps 8–15 for any set of requirements (ARCHITECTURE.md §8). The questionnaire and the
// Policy Guide both run through this: a "parent" is one question or one obligation.
import { PIPELINE } from "../config/pipeline";
import type { ModelKey } from "../config/models";
import type { LLM, UsageTracker } from "../llm/client";
import { LLMError } from "../llm/client";
import { documentsBlock, READING_SYSTEM, readerSchema, readerTask, reviewerSchema, reviewerTask, tieBreakSchema, tieBreakTask, type ProposedAnswer } from "../llm/prompts/reading";
import { estimateTokens } from "../lib/text";
import type { Evidence, Flag, Item, ItemResult, ItemStatus, ParentResult, ReaderDraft, Regulator, ReviewDraft, SearchTrail, TieBreak } from "../types";
import { buildChunks, collectCandidates, excerptPolicy, foundByLog, usableTerm, type ChunkPolicy, type FoundByEntry } from "./candidates";
import { checkFreshness, checkItem, checkNumbers, verifyEvidence, type CheckContext } from "./checks";
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

/** One set of policies that was read in full, and for which questions (or obligations). */
export type DocumentSet = { parentIds: string[]; policies: { policyId: string; mode: "full" | "excerpt"; tokens: number }[]; tokens: number; lastLook: boolean };

export type EvidenceRun = {
  results: ParentResult[];
  foundBy: FoundByEntry[];
  documentSets: DocumentSet[];
  /** Weaker candidates that were never read in full, per group. */
  leftOut: { parentIds: string[]; policyIds: string[] }[];
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

/**
 * What one item looks like after the full reading, checks and second opinion on one set of
 * documents. `failed`: the reading of that set could not be completed.
 */
export type Outcome = { status: ItemStatus; evidence: Evidence[]; flags: Flag[]; readerReason: string; reviewer: ItemResult["reviewer"]; tieBreak?: TieBreak; failed?: boolean };

/**
 * Which outcome wins when an item was checked against several sets of documents.
 * A confirmed conflict beats everything. Confirmed evidence in one set beats an open question
 * in another. A set that could not be read beats "nothing found", because nothing may be
 * called "not found" while a read is missing.
 */
function rank(o: Outcome): number {
  if (o.failed) return 1;
  return { conflict: 4, covered: 3, needs_review: 2, not_covered: 0 }[o.status];
}

const why = (e: LLMError) => `Reason: ${e.message.replace(/[.\s]+$/, "")}.`;

function split<T>(list: T[], maxSize: number): T[][] {
  const parts = Math.ceil(list.length / maxSize);
  const size = Math.ceil(list.length / parts);
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

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

/** Combines the outcomes an item got from different sets of documents (see `rank`). */
export function mergeOutcomes(outcomes: Outcome[]): Outcome {
  if (!outcomes.length) {
    return { status: "not_covered", evidence: [], flags: [], readerReason: "No policy was identified as possibly relevant.", reviewer: null };
  }
  // One set of policies states the requirement and another appears to set a different rule.
  // Each reading only saw its own set, so neither answer is safe alone: a person sees both.
  const covering = outcomes.filter((o) => !o.failed && o.status === "covered");
  const conflicting = outcomes.filter((o) => !o.failed && o.status === "conflict");
  if (covering.length && conflicting.length) {
    const ids = (os: Outcome[]) => [...new Set(os.flatMap((o) => o.evidence.map((e) => e.policyId)))].join(", ");
    const both = [...covering, ...conflicting];
    return {
      status: "needs_review",
      evidence: dedupeEvidence(both.flatMap((o) => o.evidence)),
      flags: dedupeFlags([{ code: "policies_disagree", detail: `${ids(covering)} states the requirement, but ${ids(conflicting)} appears to set a different rule.` }, ...both.flatMap((o) => o.flags)]),
      readerReason: both.map((o) => o.readerReason).filter(Boolean).join(" · "),
      reviewer: covering.map((o) => o.reviewer).find(Boolean) ?? null,
      tieBreak: conflicting.map((o) => o.tieBreak).find(Boolean),
    };
  }

  const top = Math.max(...outcomes.map(rank));
  // among equals, the one that has something to show speaks first
  const winners = outcomes.filter((o) => rank(o) === top).sort((a, b) => Number(b.evidence.length > 0) - Number(a.evidence.length > 0));
  return {
    status: winners[0].status,
    evidence: dedupeEvidence(winners.flatMap((o) => o.evidence)),
    flags: dedupeFlags(winners.flatMap((o) => o.flags)),
    readerReason: winners.map((o) => o.readerReason).filter(Boolean)[0] ?? "",
    reviewer: winners.map((o) => o.reviewer).find(Boolean) ?? null,
    tieBreak: winners.map((o) => o.tieBreak).find(Boolean),
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
  let groupsDone = 0;

  const documentSets: DocumentSet[] = [];
  const leftOut: EvidenceRun["leftOut"] = [];

  type Unit = { parent: Parent; items: Item[] };

  /**
   * One call per unit, sharing a cached prefix. If a reply for several requirements cannot be
   * read, those requirements are asked again one at a time.
   */
  async function callUnits<R extends { fromSavedCache: boolean }>(units: Unit[], thunk: (u: Unit) => () => Promise<R>, alreadyWarm: boolean): Promise<{ unit: Unit; result: R | LLMError }[]> {
    const first = await llm.warmThenAll(units.map(thunk), { alreadyWarm });
    const out: { unit: Unit; result: R | LLMError }[] = [];
    const again: Unit[] = [];
    units.forEach((unit, i) => {
      const result = first[i];
      if (result instanceof LLMError && result.kind === "invalid_output" && unit.items.length > 1) {
        again.push(...unit.items.map((item) => ({ parent: unit.parent, items: [item] })));
      } else out.push({ unit, result });
    });
    if (again.length) {
      const second = await llm.warmThenAll(again.map(thunk), { alreadyWarm: true });
      again.forEach((unit, i) => out.push({ unit, result: second[i] }));
    }
    return out;
  }

  // Steps 11–13 on one set of documents, for the given items of each parent.
  async function readAndReview(docs: ChunkPolicy[], group: Group, wanted: Map<string, Item[]>, lastLook = false): Promise<Map<string, Outcome>> {
    const out = new Map<string, Outcome>();
    const parents = group.parents.filter((p) => wanted.get(p.id)?.length);
    if (!parents.length || !docs.length) return out;
    documentSets.push({
      parentIds: parents.map((p) => p.id),
      policies: docs.map((d) => ({ policyId: d.policyId, mode: d.mode, tokens: d.tokens })),
      tokens: docs.reduce((n, d) => n + d.tokens, 0),
      lastLook,
    });
    const allowed = new Set(docs.map((d) => d.policyId));
    const localCtx: CheckContext = { ...ctx, policies: new Map([...ctx.policies].filter(([id]) => allowed.has(id))) };
    const prefix = { text: documentsBlock(docs, regulator.label, group.regulatorText), cache: true };
    const system = [{ text: READING_SYSTEM }];
    // a long checklist is read in parts, so that no reply runs out of room
    const units: Unit[] = parents.flatMap((parent) => split(wanted.get(parent.id)!, PIPELINE.itemsPerReadingCall).map((items) => ({ parent, items })));

    // Step 11 — full reading
    const readings = await callUnits(
      units,
      (u) => () => llm.call({ task: "fullReading", model: models.fullReading, system, user: [prefix, { text: readerTask(u.parent, u.items) }], schema: readerSchema, tracker, signal }),
      false,
    );

    // Step 12 — automatic checks
    const proposed = new Map<string, ProposedAnswer>();
    const reasons = new Map<string, string>();
    const reviewUnits: Unit[] = [];
    for (const { unit, result } of readings) {
      if (result instanceof LLMError) {
        for (const item of unit.items) {
          out.set(item.id, {
            status: "needs_review",
            evidence: [],
            flags: [{ code: "analysis_failed", detail: `One set of policies could not be read for this requirement. ${why(result)} Run again to retry.` }],
            readerReason: "",
            reviewer: null,
            failed: true,
          });
        }
        continue;
      }
      const drafts = new Map(result.data.items.map((d) => [d.itemId, d]));
      for (const item of unit.items) {
        const draft: ReaderDraft = drafts.get(item.id) ?? { itemId: item.id, status: "not_covered", wording: "same", evidence: [], reason: "" };
        reasons.set(item.id, draft.reason);
        proposed.set(item.id, { item, ...checkItem(item, draft, localCtx) });
      }
      reviewUnits.push(unit);
    }

    // Step 13 — second opinion, right away so the cached documents are still live
    const reviews = await callUnits(
      reviewUnits,
      (u) => () =>
        llm.call({ task: "secondOpinion", model: models.secondOpinion, system, user: [prefix, { text: reviewerTask(u.parent, u.items.map((i) => proposed.get(i.id)!)) }], schema: reviewerSchema, tracker, signal }),
      sameModel,
    );
    const reviewOf = new Map<string, ReviewDraft>();
    const reviewError = new Map<string, LLMError>();
    for (const { unit, result } of reviews) {
      if (result instanceof LLMError) unit.items.forEach((i) => reviewError.set(i.id, result));
      else for (const d of result.data.items) reviewOf.set(d.itemId, d as ReviewDraft);
    }

    // The checked answer, the second opinion and its verified quotes, per requirement.
    const cases = new Map<string, { answer: ProposedAnswer; review: ReviewDraft | null; fresh: { evidence: Evidence[]; flags: Flag[] } }>();
    for (const [id, answer] of proposed) {
      const review = reviewOf.get(id) ?? null;
      cases.set(id, { answer, review, fresh: review ? verifyEvidence(answer.item, review.newEvidence, localCtx) : { evidence: [], flags: [] } });
    }
    const needsThird = (id: string) => {
      const c = cases.get(id)!;
      return resolveSecondOpinion(c.answer, c.review, c.fresh.evidence).thirdReading;
    };

    // Third reading: settles a disagreement between the two, and confirms every conflict.
    const thirdUnits: Unit[] = reviewUnits.map((u) => ({ parent: u.parent, items: u.items.filter((i) => needsThird(i.id)) })).filter((u) => u.items.length);
    const tieOf = new Map<string, TieBreak>();
    const tieError = new Map<string, LLMError>();
    const ties = await callUnits(
      thirdUnits,
      (u) => () => {
        const disputes = u.items.map((item) => {
          const { answer, review, fresh } = cases.get(item.id)!;
          // a "covered" that failed an automatic check never gets here, so the status is one of the three answers
          const readerStatus = answer.status as "covered" | "not_covered" | "conflict";
          return {
            item,
            reader: { status: readerStatus, reason: reasons.get(item.id) ?? "", evidence: answer.evidence },
            reviewer: { status: review!.proposedStatus, reason: review!.reason, evidence: fresh.evidence },
          };
        });
        return llm.call({ task: "secondOpinion", model: models.secondOpinion, system, user: [prefix, { text: tieBreakTask(u.parent, disputes) }], schema: tieBreakSchema, tracker, signal });
      },
      true,
    );
    for (const { unit, result } of ties) {
      if (result instanceof LLMError) unit.items.forEach((i) => tieError.set(i.id, result));
      else for (const d of result.data.items) tieOf.set(d.itemId, { status: d.status, reason: d.reason });
    }

    for (const [id, { answer, review, fresh }] of cases) {
      const { item } = answer;
      const tie = tieOf.get(id) ?? null;
      const resolved = resolveSecondOpinion(answer, review, fresh.evidence, tie);
      let { status } = resolved;
      const flags = [...resolved.flags];
      const usesNewQuotes = resolved.evidence.some((e) => !answer.evidence.includes(e));
      if (usesNewQuotes) flags.push(...fresh.flags);
      if ((status === "covered" || status === "conflict") && (usesNewQuotes || status !== answer.status)) {
        // the answer or its quotes changed after Step 12: the number and freshness checks run again
        const numberFlags = checkNumbers(item, resolved.evidence);
        flags.push(...numberFlags, ...checkFreshness(resolved.evidence, localCtx));
        if (status === "covered" && numberFlags.length) status = "needs_review";
      }
      if (!review && status === "covered") {
        // "Covered" requires a second opinion that agrees. Without one, a person decides.
        status = "needs_review";
        const e = reviewError.get(id);
        flags.push({ code: "analysis_failed", detail: `The second opinion could not be completed. ${e ? why(e) : "The reply left this requirement out."} Run again to retry.` });
      }
      if (resolved.thirdReading && !tie) {
        const e = tieError.get(id);
        flags.push({ code: "analysis_failed", detail: `The tie-break could not be completed. ${e ? why(e) : "The reply left this requirement out."} Run again to retry.` });
      }
      out.set(id, { status, evidence: resolved.evidence, flags: dedupeFlags(flags), readerReason: reasons.get(id) ?? "", reviewer: resolved.reviewer, tieBreak: resolved.tieBreak });
    }
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
    (await Promise.all(chunks.map((chunk) => readAndReview(chunk.policies, group, everything)))).forEach(record);

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
      // most-pointed-to first; among equals, the one that matches an open requirement best
      const keywordRank = new Map<string, number>();
      for (const item of open) {
        library.search.topPolicies(item.requirement, 25).forEach((top, i) => keywordRank.set(top.policyId, Math.min(i, keywordRank.get(top.policyId) ?? 99)));
      }
      const rankOf = (id: string) => keywordRank.get(id) ?? 99;
      const docs: ChunkPolicy[] = [];
      let used = 0;
      for (const [policyId, v] of [...votes].sort((a, b) => b[1].n - a[1].n || rankOf(a[0]) - rankOf(b[0]) || a[0].localeCompare(b[0]))) {
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
        record(await readAndReview(docs, group, itemsOf(openIds), true));
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

    const neverRead = [...new Set(skipped.map((s) => s.policyId))].filter((id) => !read.has(id));
    if (neverRead.length) leftOut.push({ parentIds: group.parents.map((p) => p.id), policyIds: neverRead });

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
    foundBy: foundByLog(candidates),
    documentSets,
    leftOut,
    stats: {
      items: allItems.length,
      bundles: bundles.length,
      policiesRead: library.mediCal.length,
      screeningCalls,
      screeningHits: screening.hits.length,
      rescued,
      chunks: documentSets.length,
    },
  };
}

export type { Screening };
