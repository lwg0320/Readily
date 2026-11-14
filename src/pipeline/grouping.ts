// Step 8 — grouping (ARCHITECTURE.md §8). Plain code.
import { PIPELINE } from "../config/pipeline";
import type { Item } from "../types";

/**
 * Groups of neighbouring questions that are read together in Steps 11–15. Questions follow
 * the APL's order, so neighbours share a topic and need the same policies.
 */
export function groupQuestions(
  questions: { number: number; aplPages: number[] }[],
  maxSize: number = PIPELINE.maxGroupSize,
): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let firstPage = 0;
  for (const q of questions) {
    const page = q.aplPages[0] ?? firstPage;
    if (current.length && (current.length >= maxSize || page > firstPage + 1)) {
      groups.push(current);
      current = [];
    }
    if (!current.length) firstPage = page;
    current.push(q.number);
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Splits the ordered item list into `count` contiguous bundles of roughly equal size for
 * Step 9, never splitting the items of one question (or obligation) across bundles.
 */
export function bundleItems(items: Item[], count: number = PIPELINE.bundles): Item[][] {
  const byParent: Item[][] = [];
  for (const item of items) {
    const last = byParent[byParent.length - 1];
    if (last && last[0].parentId === item.parentId) last.push(item);
    else byParent.push([item]);
  }
  const n = Math.max(1, Math.min(count, byParent.length));
  const total = items.length;
  const bundles: Item[][] = [];
  let current: Item[] = [];
  let done = 0;
  for (const group of byParent) {
    current.push(...group);
    done += group.length;
    if (bundles.length < n - 1 && done >= ((bundles.length + 1) * total) / n) {
      bundles.push(current);
      current = [];
    }
  }
  if (current.length) bundles.push(current);
  return bundles;
}
