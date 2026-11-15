import { describe, expect, it } from "vitest";
import { differences } from "../src/pipeline/compare";
import type { ParentResult, Verdict } from "../src/types";

const r = (parentId: string, verdict: Verdict): ParentResult => ({ parentId, verdict, suggestedAnswer: null, suggestedCitation: "", approved: false, items: [] });

describe("differences between two runs", () => {
  const a = [r("11", "conflict"), r("2", "not_found"), r("38", "conflict"), r("10", "covered"), r("7", "partial")];
  const b = [r("2", "not_found"), r("10", "covered"), r("11", "conflict"), r("38", "partial"), r("4", "covered")];
  const d = differences(a, b);
  it("lists the questions whose verdict changed, in question order, with both answers", () => {
    expect(d.changed.map((x) => [x.parentId, x.a.verdict, x.b.verdict])).toEqual([["38", "conflict", "partial"]]);
  });
  it("counts the questions that agree and names those only one run answered", () => {
    expect(d.same).toBe(3);
    expect(d.onlyInA).toEqual(["7"]);
    expect(d.onlyInB).toEqual(["4"]);
  });
  it("reports nothing changed for identical runs", () => {
    expect(differences(a, a)).toMatchObject({ changed: [], same: 5, onlyInA: [], onlyInB: [] });
  });
});
