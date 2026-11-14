import { describe, expect, it } from "vitest";
import { bundleItems, groupQuestions } from "../src/pipeline/grouping";
import { item, loadQuestionnaire } from "./helpers";

describe("groupQuestions (Step 8)", () => {
  const q = loadQuestionnaire();
  const groups = groupQuestions(q.questions);

  it("covers all 64 questions once, in order", () => {
    expect(groups.flat()).toEqual(q.questions.map((x) => x.number));
  });
  it("keeps groups to at most 7 questions and within neighbouring APL pages", () => {
    for (const g of groups) {
      expect(g.length).toBeLessThanOrEqual(7);
      const pages = g.map((n) => q.questions[n - 1].aplPages[0]);
      expect(Math.max(...pages) - pages[0]).toBeLessThanOrEqual(1);
    }
  });
  it("produces a manageable number of groups", () => {
    expect(groups.length).toBeGreaterThanOrEqual(9);
    expect(groups.length).toBeLessThanOrEqual(16);
  });
  it("starts a new group on a page jump", () => {
    expect(groupQuestions([{ number: 1, aplPages: [1] }, { number: 2, aplPages: [2] }, { number: 3, aplPages: [5] }])).toEqual([[1, 2], [3]]);
  });
});

describe("bundleItems (Step 9)", () => {
  // question n has (n % 5) + 1 items
  const items = Array.from({ length: 30 }, (_, i) => i + 1).flatMap((n) => Array.from({ length: (n % 5) + 1 }, (_, k) => item({ id: `Q${n}-${k + 1}`, parentId: String(n) })));

  it("splits into the requested number of contiguous bundles", () => {
    const bundles = bundleItems(items, 3);
    expect(bundles).toHaveLength(3);
    expect(bundles.flat().map((i) => i.id)).toEqual(items.map((i) => i.id));
  });
  it("never splits a question across bundles", () => {
    const bundles = bundleItems(items, 3);
    const where = new Map<string, number>();
    bundles.forEach((b, bi) => b.forEach((it) => {
      if (where.has(it.parentId)) expect(where.get(it.parentId)).toBe(bi);
      where.set(it.parentId, bi);
    }));
  });
  it("keeps bundles roughly equal", () => {
    const sizes = bundleItems(items, 3).map((b) => b.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(8);
  });
  it("uses one bundle for a small set", () => {
    expect(bundleItems(items.slice(0, 4), 1)).toHaveLength(1);
    expect(bundleItems([item({ id: "OBL-1", parentId: "a" })], 3)).toHaveLength(1);
  });
});
