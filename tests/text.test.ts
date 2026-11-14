import { describe, expect, it } from "vitest";
import { loadPolicy } from "./helpers";
import { estimateTokens, extractQuantities, normalize, normalizeNumbers, normalizeWithMap, searchableWithMap } from "../src/lib/text";

describe("normalizeNumbers", () => {
  it("writes numbers one way", () => {
    expect(normalizeNumbers("five (5) calendar days")).toBe("5 calendar days");
    expect(normalizeNumbers("five calendar days")).toBe("5 calendar days");
    expect(normalizeNumbers("no later than thirty (30) calendar days")).toBe("no later than 30 calendar days");
    expect(normalizeNumbers("twenty-four (24) hours")).toBe("24 hours");
    expect(normalizeNumbers("one hundred twenty (120) calendar days")).toBe("120 calendar days");
    expect(normalizeNumbers("at least 95%")).toBe("at least 95 percent");
  });
  it("leaves unrelated bracketed numbers alone", () => {
    expect(normalizeNumbers("section 5 (12)")).toBe("section 5 (12)");
  });
});

describe("normalize", () => {
  it("removes page markers, straightens quotes and dashes, collapses whitespace, lower-cases", () => {
    expect(normalize("The Member’s  illness\n<<page 3>>\nis “terminal” – always")).toBe("the member's illness is \"terminal\" - always");
  });
  it("joins a word hyphenated across a line break", () => {
    expect(normalize("Medi-\n   Cal benefit")).toBe("medi-cal benefit");
    expect(normalize("housing- related")).toBe("housing-related");
  });
  it("maps every normalized character back to the original", () => {
    const s = "A  quick\n<<page 2>>\nBROWN fox";
    const { text, map } = normalizeWithMap(s);
    const at = text.indexOf("brown");
    expect(s.slice(map[at], map[at] + 5)).toBe("BROWN");
  });
});

describe("searchableWithMap", () => {
  it("finds a phrase across a page break and traces it back", () => {
    const s = "submit no later than\n<<page 9>>\nthirty (30) calendar days after start";
    const { text, map } = searchableWithMap(s);
    const at = text.indexOf("30 calendar days");
    expect(at).toBeGreaterThan(0);
    expect(s.slice(map[at]).startsWith("thirty (30)")).toBe(true);
  });
});

describe("extractQuantities", () => {
  it("reads values and units", () => {
    expect(extractQuantities("within five (5) calendar days")).toEqual([{ value: 5, unit: "calendar day", unitBase: "day" }]);
    expect(extractQuantities("two 90-day periods and 24 hours")).toEqual([
      { value: 90, unit: "day", unitBase: "day" },
      { value: 24, unit: "hour", unitBase: "hour" },
    ]);
    expect(extractQuantities("at least 95 percent of the rate")).toEqual([{ value: 95, unit: "percent", unitBase: "percent" }]);
    expect(extractQuantities("life expectancy of six (6) months or less")).toEqual([{ value: 6, unit: "month", unitBase: "month" }]);
  });
});

describe("estimateTokens", () => {
  it("matches the real token count of a policy to within a few percent", () => {
    expect(estimateTokens("abcde")).toBe(2);
    const gg = loadPolicy("GG.1503");
    expect(Math.abs(estimateTokens(gg.canonicalText) - 14999) / 14999).toBeLessThan(0.03);
  });
});
