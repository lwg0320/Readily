// Step 18: the filled DHCS form, checked against the real form PDF; and the CSV.
import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { runToCsv } from "../src/export/csv";
import { fillForm, formSafe } from "../src/export/fillForm";
import { estimateQuestionnaire, formatCost } from "../src/pipeline/estimate";
import { findQuote } from "../src/ui/findQuote";
import type { ParentResult } from "../src/types";
import { item, loadQuestionnaire } from "./helpers";

const FORM = path.resolve(__dirname, "../public/pdfs/questionnaires/apl-25-008.pdf");
const questionnaire = loadQuestionnaire();

describe("fillForm", () => {
  it("puts answers and citations in the right fields of the real form and leaves the rest blank", async () => {
    const bytes = await fillForm(new Uint8Array(fs.readFileSync(FORM)), questionnaire.formMap!, [
      { number: 1, answer: "yes", citation: 'GG.1503 §II.A, p.1; GG.1503 Glossary "Hospice Care", p.16' },
      { number: 12, answer: "no", citation: "" },
      { number: 64, answer: "yes", citation: "HH.2022 §II.C, p.2" },
    ]);
    const form = (await PDFDocument.load(bytes)).getForm();
    const row = (n: number) => questionnaire.formMap!.find((r) => r.number === n)!;
    const state = (n: number) => {
      const r = row(n);
      const boxes = Object.fromEntries(r.yesNo.filter((w) => w.fieldType === "checkbox").map((w) => [w.side, form.getCheckBox(w.fieldName).isChecked()]));
      const radioName = r.yesNo.find((w) => w.fieldType === "radio")?.fieldName;
      const radio = radioName ? form.getRadioGroup(radioName).getSelected() : undefined;
      const radioSide = r.yesNo.find((w) => w.fieldType === "radio" && w.onState === radio)?.side;
      return { citation: form.getTextField(r.citationField).getText() ?? "", boxes, radioSide };
    };

    expect(state(1)).toEqual({ citation: 'GG.1503 §II.A, p.1; GG.1503 Glossary "Hospice Care", p.16', boxes: { yes: true, no: false }, radioSide: "yes" });
    expect(state(12)).toEqual({ citation: "", boxes: { yes: false, no: true }, radioSide: "no" });
    expect(state(64)).toEqual({ citation: "HH.2022 §II.C, p.2", boxes: { yes: true, no: false }, radioSide: "yes" });
    // a question nobody approved stays untouched
    expect(state(2).citation).toBe("");
    expect(state(2).boxes).toEqual({ yes: false, no: false });
    expect(state(2).radioSide).toBeUndefined();
  });

  it("keeps only characters the form's font can show", () => {
    expect(formSafe("GG.1503 §II.A — “Hospice Care”, p.1 ✓")).toBe('GG.1503 §II.A - "Hospice Care", p.1 ');
  });
});

describe("runToCsv", () => {
  it("has one row per question, with quoted cells where needed", () => {
    const result: ParentResult = {
      parentId: "1",
      verdict: "covered",
      suggestedAnswer: "yes",
      suggestedCitation: "GG.1503 §II.A, p.1",
      approved: true,
      followUp: "ask Legal",
      items: [
        {
          item: item({ id: "Q1-01", parentId: "1" }),
          status: "covered",
          evidence: [{ policyId: "GG.1503", quote: 'shall be "responsible", always', page: 1, address: "II.A", kind: "body", scope: "both", status: "exact" } as any],
          readerReason: "",
          reviewer: null,
          flags: [{ code: "policy_predates_apl", detail: "GG.1503 was last revised 2024-09-01, before APL 25-008 (2025-05-05)" }],
        },
      ],
    };
    const csv = runToCsv(questionnaire.questions.slice(0, 2), [result]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Question,Question text,Verdict,Answer,Approved,Citation,All citations,Quotes,Flags,Follow-up");
    expect(lines[1]).toContain(',Covered,Yes,Yes,"GG.1503 §II.A, p.1",');
    expect(lines[1]).toContain('“shall be ""responsible"", always”');
    expect(lines[1].endsWith(",ask Legal")).toBe(true);
    expect(lines[2]).toContain("Not analysed yet");
  });
});

describe("estimateQuestionnaire", () => {
  it("is close to what the full run actually cost and took", () => {
    const e = estimateQuestionnaire({ questions: 64, mediCalPolicies: 251, models: { fullReading: "haiku", secondOpinion: "haiku" } });
    expect(e.cost).toBeGreaterThan(2.0); // measured: $2.23
    expect(e.cost).toBeLessThan(2.5);
    expect(e.minutes).toBeGreaterThanOrEqual(6);
    expect(e.minutes).toBeLessThanOrEqual(14);
  });
  it("costs much more at maximum accuracy, and a little more again when the two models differ", () => {
    const both = estimateQuestionnaire({ questions: 64, mediCalPolicies: 251, models: { fullReading: "opus", secondOpinion: "opus" } });
    const mixed = estimateQuestionnaire({ questions: 64, mediCalPolicies: 251, models: { fullReading: "haiku", secondOpinion: "opus" } });
    const standard = estimateQuestionnaire({ questions: 64, mediCalPolicies: 251, models: { fullReading: "haiku", secondOpinion: "haiku" } });
    expect(both.cost).toBeGreaterThan(40);
    expect(mixed.cost).toBeGreaterThan(standard.cost);
    expect(mixed.cost).toBeLessThan(both.cost);
  });
  it("formats money plainly", () => {
    expect([formatCost(2.257), formatCost(48.2), formatCost(0.004), formatCost(0)]).toEqual(["$2.26", "$48", "under $0.01", "$0.00"]);
  });
});

describe("findQuote (PDF highlight)", () => {
  const pieces = ["1.", " ", "A Hospice Provider shall submit Notifi-", "cation of Hospice election immediately and no later than", "thirty (30) calendar days after start of services.", " In cases of"];
  it("finds a quote across text pieces, ignoring spacing, hyphenation and quote styles", () => {
    expect(findQuote(pieces, "A Hospice Provider shall submit Notification of Hospice election immediately and no later than thirty (30) calendar days after start of services")).toEqual([2, 3, 4]);
  });
  it("falls back to the first eight words when the quote continues on the next page", () => {
    expect(findQuote(pieces, "A Hospice Provider shall submit Notification of Hospice election immediately and then something that is on another page")).toEqual([2, 3]);
  });
  it("finds nothing rather than guessing", () => {
    expect(findQuote(pieces, "Members may elect concurrent care under the age of twenty-one")).toEqual([]);
    expect(findQuote(pieces, "1.")).toEqual([]);
  });
});

describe("estimates when earlier work is saved (phase 7)", () => {
  const base = { questions: 64, mediCalPolicies: 251 };
  const haiku = { fullReading: "haiku", secondOpinion: "haiku" } as const;
  const opus = { fullReading: "opus", secondOpinion: "opus" } as const;
  const from = (models: typeof haiku | typeof opus | { fullReading: "haiku" | "opus"; secondOpinion: "haiku" | "opus" }, reuse = haiku as { fullReading: "haiku" | "opus"; secondOpinion: "haiku" | "opus" }) => estimateQuestionnaire({ ...base, models, reuse });
  it("costs nothing to run again with the same settings", () => {
    expect(from(haiku).cost).toBe(0);
  });
  it("pays only for the switched steps, never again for the pass over every policy", () => {
    const scratch = estimateQuestionnaire({ ...base, models: opus }).cost;
    const upgrade = from(opus).cost;
    expect(scratch - upgrade).toBeGreaterThan(0.7); // the checklists and the first pass, about $0.75
    expect(scratch - upgrade).toBeLessThan(0.8);
  });
  it("a new second opinion alone is cheaper than a new reading plus the second opinion it needs", () => {
    const onlySecond = from({ fullReading: "haiku", secondOpinion: "opus" }).cost;
    const onlyReading = from({ fullReading: "opus", secondOpinion: "haiku" }).cost;
    expect(onlySecond).toBeGreaterThan(10);
    expect(onlySecond).toBeLessThan(from(opus).cost);
    // switching the reading also re-pays the standard second opinion on the new reading
    expect(onlyReading).toBeGreaterThan(estimateQuestionnaire({ ...base, models: opus }).cost / 2);
  });
});
