// Shared types. The "stored" shapes are what `npm run prep` writes under public/data.

// ------------------------------------------------------------------ prepared documents

export type SpanKind = "body" | "glossary" | "references";
export type Scope = "medi-cal" | "other" | "both";

export type PolicySpan = { start: number; end: number; page: number; address: string; kind: SpanKind; scope: Scope };

export type Policy = {
  id: string;
  title: string;
  department: string;
  section: string;
  effectiveDate: string | null; // ISO yyyy-mm-dd
  revisedDate: string | null;
  programs: { mediCal: boolean; oneCare: boolean; pace: boolean; administrative: boolean };
  pageCount: number;
  referencedApls: string[];
  canonicalText: string;
  tokenEstimate: number;
  spans: PolicySpan[];
  outline: { address: string; firstLine: string; pageStart: number; pageEnd: number }[];
  folder: string;
};

export type Apl = {
  id: string;
  kind: "regulator";
  number: string;
  subject: string;
  date: string | null;
  supersedes: string[];
  pageCount: number;
  pages: { page: number; text: string }[];
  sourceFile: string;
};

export type YesNoWidget = {
  fieldName: string;
  fieldType: "radio" | "checkbox";
  widgetIndex: number;
  onState: string;
  side: "yes" | "no";
};

export type Question = { number: number; text: string; aplPages: number[]; reference: string };

export type Questionnaire = {
  id: string;
  title: string;
  aplId: string;
  aplNumber: string;
  subject: string;
  pageCount: number;
  questions: Question[];
  formMap: null | { number: number; citationField: string; yesNo: YesNoWidget[] }[];
};

export type GuideSection = {
  id: string;
  title: string;
  path: string[];
  pageStart: number;
  pageEnd: number;
  updated: boolean;
  source: "bookmark" | "marker";
  wordCount: number;
  text: string;
  parentIntro: string;
};

export type Guide = {
  id: string;
  title: string;
  date: string;
  pageCount: number;
  sections: GuideSection[];
  stats: { bookmarkHeadings: number; markerStarts: number; updatedSections: number; droppedShort: number; notLocated: number; footnotes: number };
};

/** The regulator document a run is checked against (an APL, or a Policy Guide). */
export type Regulator = { label: string; date: string | null; supersedes: string[]; isGuide: boolean };

// ------------------------------------------------------------------ pipeline (ARCHITECTURE.md §8)

export type Quantity = { value: number; unit: string; unitBase: string };

export type Item = {
  id: string; // "Q25-03" or "OBL-s015-02"
  parentId: string; // question number or obligation id, as a string
  requirement: string;
  quantities: Quantity[];
  searchTerms: string[];
  allowsReference: boolean;
};

export type Evidence = {
  policyId: string;
  quote: string; // always the source text, never the model's wording
  page: number;
  address: string;
  kind: SpanKind;
  scope: Scope;
  status: "exact" | "corrected";
};

export type FlagCode =
  | "wording_differs"
  | "number_mismatch"
  | "number_not_shown"
  | "reviewer_disputed"
  | "reviewer_found_evidence"
  | "conflict_unconfirmed"
  | "policies_disagree"
  | "policy_predates_apl"
  | "cites_superseded_apl"
  | "quote_corrected"
  | "wrong_program_removed"
  | "list_count_mismatch"
  | "analysis_failed";

export type Flag = { code: FlagCode; detail: string };

export type ItemStatus = "covered" | "not_covered" | "conflict" | "needs_review";

export type SearchTrail = {
  policiesRead: number;
  exactTerms: { term: string; hits: number }[];
  closest: { policyId: string; title: string; address: string; page: number } | null;
  skippedCandidates: string[];
};

export type ItemResult = {
  item: Item;
  status: ItemStatus;
  evidence: Evidence[];
  readerReason: string;
  reviewer: { agrees: boolean; reason: string } | null;
  /** Present when the full reading and the second opinion disagreed and a third reading settled it. */
  tieBreak?: TieBreak;
  flags: Flag[];
  trail?: SearchTrail;
};

export type Verdict = "conflict" | "needs_review" | "partial" | "not_found" | "covered";

export type ParentResult = {
  parentId: string;
  verdict: Verdict;
  items: ItemResult[];
  suggestedAnswer: "yes" | "no" | null;
  suggestedCitation: string;
  approved: boolean;
  edited?: { answer: "yes" | "no"; citation: string };
  followUp?: string;
};

/** What a reader model proposes for one item, before any checks. */
export type ReaderDraft = {
  itemId: string;
  status: "covered" | "not_covered" | "conflict";
  wording: "same" | "equivalent";
  evidence: { policyId: string; quote: string }[];
  reason: string;
};

/** What the second-opinion model says about one item. */
export type ReviewDraft = {
  itemId: string;
  agrees: boolean;
  proposedStatus: "covered" | "not_covered" | "conflict";
  reason: string;
  newEvidence: { policyId: string; quote: string }[];
};

export type TieBreak = { status: "covered" | "not_covered" | "conflict"; reason: string };

export type FoundBy = "haiku-direct" | "haiku-maybe" | "exact" | "keyword";
