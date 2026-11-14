// Step 9 — read every Medi-Cal policy (ARCHITECTURE.md §8).
// One cheap call per policy per bundle. Because every policy really is read, a later
// "not found" means "all of them were checked".
import type { LLM, UsageTracker } from "../llm/client";
import { LLMError } from "../llm/client";
import { screeningSchema, screeningSystem, screeningUser } from "../llm/prompts/screening";
import type { Item, Policy } from "../types";
import type { ScreeningHit } from "./candidates";
import type { OnProgress } from "./progress";

export type Screening = {
  hits: ScreeningHit[];
  /** bundle index → policies whose read finished */
  completed: Map<number, Set<string>>;
  bundleOf: Map<string, number>;
  /** Re-runs any reads that failed for a bundle; returns the hits they add. */
  retryMissing(bundleIndex: number): Promise<ScreeningHit[]>;
  totalPolicies: number;
};

export async function readEveryPolicy(args: {
  bundles: Item[][];
  policies: Policy[];
  llm: LLM;
  tracker?: UsageTracker;
  signal?: AbortSignal;
  onProgress?: OnProgress;
}): Promise<Screening> {
  const { bundles, policies, llm, tracker, signal, onProgress } = args;
  const total = bundles.length * policies.length;
  let done = 0;
  const hits: ScreeningHit[] = [];
  const completed = new Map<number, Set<string>>(bundles.map((_, i) => [i, new Set<string>()]));
  const bundleOf = new Map<string, number>();
  bundles.forEach((b, i) => b.forEach((it) => bundleOf.set(it.id, i)));

  const readBundle = async (bundleIndex: number, which: Policy[], countProgress: boolean): Promise<ScreeningHit[]> => {
    const items = bundles[bundleIndex];
    const ids = new Set(items.map((i) => i.id));
    const system = [{ text: screeningSystem(items), cache: true }];
    const found: ScreeningHit[] = [];
    const results = await llm.warmThenAll(
      which.map((policy) => async () => {
        const r = await llm.call({ task: "readEveryPolicy", system, user: [{ text: screeningUser(policy.canonicalText) }], schema: screeningSchema, tracker, signal });
        if (countProgress) onProgress?.({ stage: "screening", done: ++done, total });
        return { policyId: policy.id, hits: r.data.hits, fromSavedCache: r.fromSavedCache };
      }),
    );
    results.forEach((r, i) => {
      if (r instanceof LLMError) {
        if (countProgress) onProgress?.({ stage: "screening", done: ++done, total });
        return; // left incomplete; Step 14 retries it before anything is called "not found"
      }
      completed.get(bundleIndex)!.add(which[i].id);
      for (const h of r.hits) {
        if (!ids.has(h.itemId)) continue; // the model named a requirement that is not in this bundle
        found.push({ policyId: r.policyId, itemId: h.itemId, address: h.address.slice(0, 120), strength: h.strength });
      }
    });
    return found;
  };

  const perBundle = await Promise.all(bundles.map((_, i) => readBundle(i, policies, true)));
  hits.push(...perBundle.flat());

  const retrying = new Map<number, Promise<ScreeningHit[]>>();
  const retryMissing = (bundleIndex: number): Promise<ScreeningHit[]> => {
    let p = retrying.get(bundleIndex);
    if (!p) {
      const missing = policies.filter((pol) => !completed.get(bundleIndex)!.has(pol.id));
      p = missing.length ? readBundle(bundleIndex, missing, false).then((h) => (hits.push(...h), h)) : Promise.resolve([]);
      retrying.set(bundleIndex, p);
    }
    return p;
  };

  return { hits, completed, bundleOf, retryMissing, totalPolicies: policies.length };
}
