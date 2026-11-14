// Step 18 — put approved answers into the real DHCS form (ARCHITECTURE.md §11).
import { PDFDocument } from "pdf-lib";
import type { Questionnaire } from "../types";

export type FormAnswer = { number: number; answer: "yes" | "no"; citation: string };

/** The form's fields use a standard PDF font, which only has Latin-1 characters. */
export function formSafe(text: string): string {
  return text
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, "");
}

/**
 * Returns the form with each given answer filled in: the citation text, and every Yes/No box
 * for that question (the form has both a check box and a radio button per side).
 * Questions without an answer are left exactly as they were.
 */
export async function fillForm(formPdf: ArrayBuffer | Uint8Array, formMap: NonNullable<Questionnaire["formMap"]>, answers: FormAnswer[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(formPdf);
  const form = pdf.getForm();
  const rows = new Map(formMap.map((r) => [r.number, r]));

  for (const a of answers) {
    const row = rows.get(a.number);
    if (!row) continue;
    const text = form.getTextField(row.citationField);
    text.setFontSize(0); // auto-size to the one-line field
    text.setText(formSafe(a.citation));

    for (const w of row.yesNo) {
      const on = w.side === a.answer;
      if (w.fieldType === "checkbox") {
        const box = form.getCheckBox(w.fieldName);
        if (on) box.check();
        else box.uncheck();
      } else if (on) {
        form.getRadioGroup(w.fieldName).select(w.onState);
      }
    }
  }
  return pdf.save();
}
