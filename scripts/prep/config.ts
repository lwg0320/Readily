import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../..");
export const SOURCE = path.join(ROOT, "source", "Readily");
export const DATA = path.join(ROOT, "public", "data");
export const PDFS = path.join(ROOT, "public", "pdfs");

export const POLICIES_DIR = path.join(SOURCE, "Public Policies");
export const APL_DIR = path.join(SOURCE, "APL");

/** Questionnaires to prepare. `id` is used in file names and routes. */
export const QUESTIONNAIRES = [
  { id: "apl-25-008", file: "Regulatory Questionnaire.pdf", aplId: "APL25-008" },
];

/** Policy Guides to prepare. */
export const GUIDES = [
  {
    id: "ecm-2026-01",
    file: "ECM Policy Guidelines.pdf",
    title: "CalAIM Enhanced Care Management Policy Guide",
    date: "2026-01-01",
  },
];

export const PLAN_NAME = "CalOptima Health";
