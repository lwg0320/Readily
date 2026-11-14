// DHCS Submission Review Form (ARCHITECTURE.md §5.4): questions + map of the fillable fields.
import fs from "node:fs";
import { PDFCheckBox, PDFDocument, PDFRadioGroup, PDFTextField, type PDFRef } from "pdf-lib";
import { pdfToPages } from "./extract";

export type YesNoWidget = {
  fieldName: string;
  fieldType: "radio" | "checkbox";
  widgetIndex: number;
  onState: string;
  side: "yes" | "no";
};

export type Questionnaire = {
  id: string;
  title: string;
  aplId: string;
  aplNumber: string;
  subject: string;
  pageCount: number;
  questions: { number: number; text: string; aplPages: number[]; reference: string }[];
  formMap: null | { number: number; citationField: string; yesNo: YesNoWidget[] }[];
  warnings: string[];
};

const NOISE = [/^\s*Rev\.\s*\d{2}\/\d{4}\s*$/, /^\s*Yes\s+No\s*$/, /^\s*Citation:?\s*$/];
const Q_START = /^\s*(\d{1,2})\.\s+(Do(?:es)?\b.*)$/;
const REFERENCE = /\(Reference:\s*APL\s*(\d{2}-\d{3}),\s*pages?\s*([\d\s,\-–]+(?:and\s*\d+)?)\)/i;

function parsePages(s: string): number[] {
  const out = new Set<number>();
  for (const part of s.split(/,|and/)) {
    const r = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (r) for (let p = Number(r[1]); p <= Number(r[2]); p++) out.add(p);
    else if (/^\d+$/.test(part.trim())) out.add(Number(part.trim()));
  }
  return [...out].sort((a, b) => a - b);
}

function parseQuestions(pages: string[][], warnings: string[]) {
  const lines = pages.flat().filter((l) => !NOISE.some((re) => re.test(l)));
  const questions: Questionnaire["questions"] = [];
  let cur: { number: number; parts: string[] } | null = null;
  for (const line of lines) {
    const start = line.match(Q_START);
    if (start && Number(start[1]) === questions.length + 1 && !cur) {
      cur = { number: Number(start[1]), parts: [start[2].trim()] };
    } else if (cur) {
      cur.parts.push(line.trim());
    }
    if (cur) {
      const joined = cur.parts.filter(Boolean).join(" ").replace(/\s+/g, " ");
      const ref = joined.match(REFERENCE);
      if (ref) {
        questions.push({
          number: cur.number,
          text: joined.slice(0, ref.index).trim(),
          aplPages: parsePages(ref[2]),
          reference: ref[0].replace(/^\(|\)$/g, ""),
        });
        cur = null;
      }
    }
  }
  if (cur) warnings.push(`question ${cur.number} has no reference line`);
  return questions;
}

async function buildFormMap(file: string, expected: number, warnings: string[]): Promise<Questionnaire["formMap"]> {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  const pages = doc.getPages();
  const pageOfRef = new Map<string, number>();
  pages.forEach((p, i) => {
    const annots = p.node.Annots();
    if (!annots) return;
    for (let k = 0; k < annots.size(); k++) pageOfRef.set(String(annots.get(k)), i + 1);
  });
  const pageIndexOf = (ref: PDFRef | undefined) => (ref ? pages.findIndex((p) => p.ref === ref) + 1 : 0);

  type W = { page: number; x: number; y: number; top: number; fieldName: string; kind: "text" | "radio" | "checkbox"; widgetIndex: number; onState: string };
  const widgets: W[] = [];
  for (const field of doc.getForm().getFields()) {
    const kind =
      field instanceof PDFTextField ? "text" : field instanceof PDFRadioGroup ? "radio" : field instanceof PDFCheckBox ? "checkbox" : null;
    if (!kind) continue;
    field.acroField.getWidgets().forEach((w, widgetIndex) => {
      const r = w.getRectangle();
      const ref = doc.context.getObjectRef(w.dict);
      const page = pageIndexOf(w.P()) || (ref ? pageOfRef.get(String(ref)) || 0 : 0);
      const on = w.getOnValue();
      widgets.push({
        page,
        x: r.x,
        y: r.y + r.height / 2,
        top: r.y + r.height,
        fieldName: field.getName(),
        kind,
        widgetIndex,
        onState: on ? on.decodeText() : "",
      });
    });
  }
  if (widgets.some((w) => !w.page)) warnings.push("some form widgets could not be placed on a page");

  const inHeader = (w: W) => w.page === 1 && w.top > 300;
  const readingOrder = (a: { page: number; y: number }, b: { page: number; y: number }) => a.page - b.page || b.y - a.y;

  const citations = widgets.filter((w) => w.kind === "text" && !inHeader(w)).sort(readingOrder);

  const buttons = widgets.filter(
    (w) => w.kind !== "text" && !inHeader(w) && ((w.x >= 26 && w.x <= 46) || (w.x >= 80 && w.x <= 100)),
  );
  buttons.sort(readingOrder);
  const rows: { page: number; y: number; items: W[] }[] = [];
  for (const b of buttons) {
    const row = rows.find((r) => r.page === b.page && Math.abs(r.y - b.y) <= 8);
    if (row) row.items.push(b);
    else rows.push({ page: b.page, y: b.y, items: [b] });
  }
  const complete = rows.filter((r) => r.items.some((w) => w.x <= 46) && r.items.some((w) => w.x >= 80)).sort(readingOrder);

  if (citations.length !== expected || complete.length !== expected) {
    warnings.push(`form map incomplete: ${citations.length} citation fields, ${complete.length} Yes/No rows, expected ${expected}`);
    return null;
  }
  return citations.map((c, i) => ({
    number: i + 1,
    citationField: c.fieldName,
    yesNo: complete[i].items.map((w) => ({
      fieldName: w.fieldName,
      fieldType: w.kind as "radio" | "checkbox",
      widgetIndex: w.widgetIndex,
      onState: w.onState,
      side: w.x <= 46 ? ("yes" as const) : ("no" as const),
    })),
  }));
}

export async function parseQuestionnaire(file: string, id: string, aplId: string): Promise<Questionnaire> {
  const warnings: string[] = [];
  const pages = pdfToPages(file);
  const questions = parseQuestions(pages, warnings);

  const head = pages[0].join("\n");
  const item = (head.match(/SUBMISSION ITEM:\s*([\s\S]*?)\n\s*☐/) || [])[1] || "";
  const itemText = item.replace(/\s+/g, " ").trim();
  const aplNumber = (itemText.match(/(\d{2}-\d{3})/) || [])[1] || "";
  const subject = itemText.includes(":") ? itemText.slice(itemText.indexOf(":", itemText.indexOf(aplNumber)) + 1).trim() : itemText;

  const formMap = await buildFormMap(file, questions.length, warnings);
  return {
    id,
    title: `DHCS Submission Review Form — APL ${aplNumber}: ${subject}`,
    aplId,
    aplNumber,
    subject,
    pageCount: pages.length,
    questions,
    formMap,
    warnings,
  };
}
