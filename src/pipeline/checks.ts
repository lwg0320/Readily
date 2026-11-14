// Step 12 — automatic checks (ARCHITECTURE.md §8). Plain code, no AI.
import { verifyQuote } from "../lib/quotes";
import { extractQuantities } from "../lib/text";
import type { Evidence, Flag, Item, ItemStatus, Policy, ReaderDraft, Regulator } from "../types";

export type CheckContext = { policies: Map<string, Policy>; regulator: Regulator };

/**
 * Checks 1–2: every quote must exist word for word in a Medi-Cal policy, in text that applies
 * to Medi-Cal, and in a section that can serve as evidence. Anything else is removed.
 */
export function verifyEvidence(
  item: Item,
  proposed: { policyId: string; quote: string }[],
  ctx: CheckContext,
): { evidence: Evidence[]; flags: Flag[] } {
  const evidence: Evidence[] = [];
  const flags: Flag[] = [];
  const seen = new Set<string>();
  for (const e of proposed) {
    const policy = ctx.policies.get(e.policyId);
    if (!policy) continue; // a policy the model was not given, or a made-up ID
    const v = verifyQuote(policy, e.quote);
    if (v.status === "rejected") continue;
    if (!policy.programs.mediCal) {
      flags.push({ code: "wrong_program_removed", detail: `${policy.id} does not apply to Medi-Cal` });
      continue;
    }
    if (v.scope === "other") {
      flags.push({ code: "wrong_program_removed", detail: `${policy.id} §${v.address} applies to another program` });
      continue;
    }
    if (v.kind === "references" && !item.allowsReference) continue;
    const key = `${policy.id}:${v.start}:${v.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (v.status === "corrected") flags.push({ code: "quote_corrected", detail: `${policy.id} §${v.address}` });
    evidence.push({ policyId: policy.id, quote: v.text, page: v.page, address: v.address, kind: v.kind, scope: v.scope, status: v.status });
  }
  return { evidence, flags };
}

/** Check 4: numbers and deadlines in the requirement must appear in the quotes. */
export function checkNumbers(item: Item, evidence: Evidence[]): Flag[] {
  const flags: Flag[] = [];
  if (!item.quantities.length) return flags;
  const quoted = evidence.flatMap((e) => extractQuantities(e.quote));
  for (const need of item.quantities) {
    const sameBase = quoted.filter((q) => q.unitBase === need.unitBase);
    if (sameBase.some((q) => q.value === need.value)) continue;
    if (sameBase.length) {
      const found = [...new Set(sameBase.map((q) => `${q.value} ${q.unit}s`))].join(", ");
      flags.push({ code: "number_mismatch", detail: `Requirement: ${need.value} ${need.unit}s · Policy: ${found}` });
    } else {
      flags.push({ code: "number_not_shown", detail: `Requirement: ${need.value} ${need.unit}s · not shown in the quoted text` });
    }
  }
  return flags;
}

/** Check 5: warn when a cited policy is older than the regulator document, or cites one it replaced. */
export function checkFreshness(evidence: Evidence[], ctx: CheckContext): Flag[] {
  const flags: Flag[] = [];
  const { regulator } = ctx;
  for (const id of new Set(evidence.map((e) => e.policyId))) {
    const p = ctx.policies.get(id);
    if (!p) continue;
    if (regulator.date && p.revisedDate && p.revisedDate < regulator.date) {
      flags.push({ code: "policy_predates_apl", detail: `${p.id} was last revised ${p.revisedDate}, before ${regulator.label} (${regulator.date})` });
    }
    if (!regulator.isGuide) {
      const old = p.referencedApls.filter((a) => regulator.supersedes.includes(a));
      if (old.length) flags.push({ code: "cites_superseded_apl", detail: `${p.id} cites APL ${old.join(", ")}, which ${regulator.label} replaced` });
    }
  }
  return flags;
}

export type CheckedItem = { status: ItemStatus; evidence: Evidence[]; flags: Flag[] };

/** Runs all automatic checks on what a reader proposed for one item. */
export function checkItem(item: Item, draft: ReaderDraft, ctx: CheckContext): CheckedItem {
  const { evidence, flags } = verifyEvidence(item, draft.evidence, ctx);
  let status: ItemStatus = draft.status;

  // 3. a claim with no surviving evidence is not proven
  if ((status === "covered" || status === "conflict") && evidence.length === 0) status = "not_covered";
  // quotes offered for something the reader itself called not covered are not evidence
  const kept = status === "not_covered" ? [] : evidence;

  if (status === "covered" || status === "conflict") {
    const numberFlags = checkNumbers(item, kept);
    flags.push(...numberFlags);
    if (status === "covered" && numberFlags.length) status = "needs_review";
    if (status !== "conflict" && draft.wording === "equivalent" && draft.status === "covered") {
      flags.push({ code: "wording_differs", detail: draft.reason });
    }
    flags.push(...checkFreshness(kept, ctx));
  }
  return { status, evidence: kept, flags };
}
