# Readily Module — Architecture

A local web app that helps a Medi-Cal compliance analyst ("Alex") do two jobs:

1. **Answer a DHCS Submission Review Form.** For each question, find the exact passage in the plan's policies (P&Ps) that proves compliance, with quote, section and page.
2. **Review a DHCS Policy Guide section by section.** Pull out every obligation in a section and check each one against the P&Ps.

This document is the single source of truth for the build. If something is not in this document, do not build it. Section 14 lists what is deliberately left out.

---

## 1. Goals and constraints

- **Accuracy first, then cost.** A wrong "Covered" becomes a regulatory finding. Uncertain answers must never be shown as Covered.
- **Every answer shows its evidence:** exact quote, policy ID, section address, page. One click opens the PDF at that page.
- **Runs locally** with `npm run dev`. It must also work unchanged as a static site (GitHub Pages later). So: **no server.**
- **The browser calls the Anthropic API directly**, with a key the user pastes into Settings.
- **All document preparation happens in a local build script** that writes static JSON. The app only loads those files.
- **All AI tasks default to Claude Haiku 5.5.** Models are set in one config file. Two tasks can be switched to Opus 5.5 from the UI.
- **Caching everywhere:** API prompt caching inside a run, and saved results between runs.
- This is a **demo meant to convince a buyer.** The UI matters as much as the pipeline.

---

## 2. Source material (verified facts)

The source folder is `Readily/`. Copy it to `source/Readily/` in the repo. Ignore `__MACOSX` and `.DS_Store`.

| Path | What it is | Verified facts |
|---|---|---|
| `Public Policies/<FOLDER>/*.pdf` | The plan's P&Ps (CalOptima Health) | 373 PDFs in 10 folders (AA, CMC, DD, EE, FF, GA, GG, HH, MA, PA). 3,632 pages. All text-based (no OCR). **251 apply to Medi-Cal.** |
| `Regulatory Questionnaire.pdf` | DHCS Submission Review Form for APL 25-008 (Hospice) | 14 pages, **64 questions**, fillable form fields |
| `APL/APL25-008.pdf` | The APL the questionnaire is about | 17 pages. Each page after the first starts with `APL 25-008` / `Page N`. PDF page N = printed page N. First page contains `SUPERSEDES ALL PLAN LETTER 13-014` and `DATE: May 5, 2025`. |
| `ECM Policy Guidelines.pdf` | CalAIM ECM Policy Guide, January 2026 | 145 pages, has PDF bookmarks, 22 `(Updated January 2026)` markers in the text |

**P&P facts the parser relies on**

- File name: `<ID>_<anything>.pdf`. The ID is the text before the first `_` (for example `GG.1503`, `AA.1207a`). All 373 IDs are unique and match the `Policy:` field in the header.
- Every P&P starts with a header box: `Policy:`, `Title:` (may wrap over 2–3 lines), `Department:`, `Section:`, `CEO Approval:`, `Effective Date:`, `Revised Date:`, `Applicable to:` followed by four checkbox lines using `☒` (checked) and `☐` (unchecked) for Medi-Cal, OneCare, PACE, Administrative.
- 5 policies have no `Revised Date` in the header (DD.2014, EE.1145, GG.1668, HH.3024, PA.2003). Fall back to the `v########` date in the file name, then to `Effective Date`.
- Top-level sections use Roman numerals with ALL-CAPS titles, usually: `I. PURPOSE`, `II. POLICY`, `III. PROCEDURE`, `IV. ATTACHMENT(S)`, `V. REFERENCE(S)`, `VI. REGULATORY AGENCY APPROVAL(S)`, `VII. BOARD ACTION(S)`, `VIII. REVISION HISTORY`, `IX. GLOSSARY`. A few policies use `DEFINITIONS` instead (for example AA.1000, the plan-wide glossary, whose entries look like `Term: definition`).
- Below that the outline is `A.` → `1.` → `a.` → `i.`, shown by indentation.
- 366 policies have a glossary laid out as a two-column table with a `Term   Definition` header row. Term names often wrap over several lines in the left column.
- Page footers look like `Page 2 of 18   GG.1503: <title>   Revised Date: 09/01/2024`, sometimes followed by a second line continuing the title.
- Policies are small. Measured on the prepared text with the app's estimate (characters ÷ 4): the 251 Medi-Cal policies total ≈ 1.46M tokens, average ≈ 5.8k, largest AA.1000 ≈ 62k, and only two exceed 25k (AA.1000, GG.1600). Real token counts are likely somewhat lower.

**Known traps (use these as test cases)**

- `GG.1503` (hospice) §II.B is **Medicare** eligibility and §II.C is **Medi-Cal** eligibility. The sentences are almost identical. Only §II.C may be cited.
- Inside `GG.1503` §II there is a lettered item `I.` (the ninth letter, after `H.`). It is not Roman section I.
- `MA.6113` "Hospice and Part D" mentions hospice heavily but is OneCare-only. It must never be cited.
- `GG.1503`'s list of 12 hospice services is in its **glossary** (entry "Hospice Care", page 16).
- `GG.1503` §III.F.1 says notification "no later than thirty (30) calendar days"; questionnaire Q11 asks about "five calendar days".
- `GG.1503` lists `APL 13-014` in its References and was revised 09/01/2024, before APL 25-008 (05/05/2025).
- The P&Ps write numbers as `five (5) calendar days`. DHCS writes `five calendar days`.
- "Transitional Rent" and "streamlined authorization" appear in **zero** P&Ps.

---

## 3. Tech stack

| Concern | Choice |
|---|---|
| Language | TypeScript everywhere |
| App | Vite + React 18, React Router (hash router, so it works on GitHub Pages) |
| Styling | Tailwind CSS |
| State | Zustand for UI state; IndexedDB (`idb-keyval`) for saved results; `localStorage` for the API key |
| PDF viewing | `react-pdf` (pdf.js) with the text layer enabled |
| PDF form filling | `pdf-lib` (in the browser) |
| Search | `minisearch` (BM25-style), index built by the prep script |
| Validation | `zod` for every model response |
| Prep scripts | Node 20+, run with `tsx` |
| PDF text extraction (prep only) | **`pdftotext -layout` from Poppler**, called from Node. The parsing rules in this document were verified against its output. Prerequisite: `brew install poppler`. |
| PDF bookmarks and form fields (prep only) | `pdfjs-dist` (bookmarks), `pdf-lib` (form fields) |
| Tests | Vitest, for the pure-code modules only |

No backend, no database server, no embeddings, no Batch API.

---

## 4. Repository layout

```
/
  ARCHITECTURE.md
  package.json, vite.config.ts, tailwind.config.js, tsconfig.json
  source/Readily/                  # the given folder, untouched (git-ignored; only needed to re-run prep)
  scripts/prep/
    index.ts                       # runs everything below in order
    extract.ts                     # pdftotext wrapper, page splitting
    policies.ts                    # header, sections, glossary, references
    apl.ts                         # APL pages + metadata
    questionnaire.ts               # questions + form field map
    guide.ts                       # section list for the Policy Guide
    searchIndex.ts                 # MiniSearch index
    report.ts                      # prints the acceptance checks in §5.7
  public/
    data/                          # GENERATED by prep (committed)
      library.json                 # counts + policy list (header fields only)
      policies/<ID>.json           # one file per policy
      apl/APL25-008.json
      questionnaires/apl-25-008.json
      guides/ecm-2026-01.json
      search-index.json
    pdfs/                          # COPIED by prep (committed)
      policies/<ID>.pdf
      apl/APL25-008.pdf
      questionnaires/apl-25-008.pdf
      guides/ecm-2026-01.pdf
    demo/                          # optional saved runs for replay (see §9.3)
  src/
    config/models.ts               # THE model + price settings file (§6)
    config/pipeline.ts             # bundle count, token caps, concurrency
    lib/text.ts                    # normalization, number parsing, token estimate
    lib/quotes.ts                  # quote verification
    lib/search.ts                  # exact + keyword search
    llm/client.ts                  # fetch wrapper, retries, concurrency, usage
    llm/cache.ts                   # saved-call cache in IndexedDB
    llm/prompts/*.ts               # one file per AI task
    pipeline/checklist.ts          # Step 7
    pipeline/grouping.ts           # Step 8
    pipeline/readEveryPolicy.ts    # Step 9
    pipeline/candidates.ts         # Step 10
    pipeline/fullReading.ts        # Step 11
    pipeline/checks.ts             # Step 12
    pipeline/secondOpinion.ts      # Step 13
    pipeline/notFound.ts           # Step 14
    pipeline/verdicts.ts           # Step 15
    pipeline/runQuestionnaire.ts   # orchestrates 7–15
    pipeline/findObligations.ts    # Step 22
    pipeline/runSectionCheck.ts    # Step 24 (reuses 8–15)
    pipeline/estimate.ts           # cost + time estimates
    export/fillForm.ts             # Step 18
    store/*.ts
    ui/…                           # screens and components (§10)
    eval/                          # dev-only accuracy page (§12)
```

Also create a `README.md` (prerequisites: Node 20+, Poppler; then `npm install`, `npm run prep`, `npm run dev`; where to paste the API key; what is deliberately not built) and a `.gitignore` (`node_modules`, `dist`, `.env*`).

`npm run prep` generates `public/data` and `public/pdfs`. `npm run dev` starts the app. The generated files are committed so the static site works without Poppler.

---

## 5. Prep pipeline (plain code, run once)

### 5.1 Text extraction (`extract.ts`)

- Run `pdftotext -layout <file> -` and split the output on form-feed (`\f`). Each chunk is one page.
- Keep the raw lines with their leading spaces. Indentation is needed for the outline.
- Drop footer lines: any line matching `Page \d+ of \d+`, plus the next line if it is short, heavily indented and continues the policy title.

### 5.2 Policies (`policies.ts`) → `public/data/policies/<ID>.json`

**Header.** Read from the first ~30 lines: `id`, `title` (join wrapped lines until `Department:`), `department`, `section`, `effectiveDate`, `revisedDate` (with the fallbacks in §2), and `programs: { mediCal, oneCare, pace, administrative }` from the `☒/☐` lines. Assert the header ID equals the file-name ID.

**Top-level sections.** A line is a Roman section header only if it matches `^\s{0,10}(I|II|III|IV|V|VI|VII|VIII|IX|X)\.\s+[A-Z][A-Z &()/'’-]+\s*$` (ALL-CAPS title) **and** the numeral is the next one expected. This is what separates Roman `I. PURPOSE` from the lettered item `I.` inside §II.

Classify each top-level section by its title:

| Title contains | `kind` | Can it be evidence? |
|---|---|---|
| PURPOSE, POLICY, PROCEDURE | `body` | Yes |
| GLOSSARY, DEFINITIONS | `glossary` | Yes |
| REFERENCE | `references` | Only for "the P&P may reference X" items |
| ATTACHMENT, APPROVAL, BOARD ACTION, REVISION HISTORY | `admin` | No |

**Outline inside body sections.** Walk lines in order and keep a stack of labels. A new item starts when a line begins (after indentation) with `A.`–`Z.`, `1.`–`99.`, `a.`–`z.` or `i.`–`xx.` followed by spaces and text. Use indentation depth and the previous sibling's label to decide the level (for example `i.` after `h.` at the same indent is a letter; `i.` deeper than `a.` is a Roman sub-item). Each item gets an address such as `II.C.2` and records `pageStart`, `pageEnd`.

**Program scope.** Only in body sections (never in References). The rule is deliberately narrow, because a heading like "Medicare Crossover" inside a Medi-Cal policy is still Medi-Cal content and must stay citable. An item gets its own scope in two cases:
- Its text begins with `For Medicare`, `For OneCare` or `For Medi-Cal`. Look at its first 8 words: only Medicare/OneCare → `"other"`; only Medi-Cal → `"medi-cal"`; both → no own scope.
- Its own text (before any child item) is heading-like (≤ 14 words, and ends with `:` or has no closing `.`/`;`) **and** names one program as its subject: it is just the program name (`OneCare`, `Medicare (OneCare)`), or starts with the program name and contains Eligibility / Requirement(s) / Member(s) / Benefit(s), or contains "for/applicable to <program>". Medicare/OneCare without Medi-Cal → `"other"`; Medi-Cal without the others → `"medi-cal"`.

Otherwise the item inherits from its parent (default `"both"`). Children inherit their parent's scope. Test: `GG.1503` `II.B` is `"other"`, `II.C` is `"medi-cal"`, `II.F.2` ("For OneCare, and Medi-Cal primary Members…") is `"both"`.

**Glossary.** For the table format, the `Term   Definition` header row gives the term indent. The definition column cannot be read from the header: it drifts within a page and changes from page to page. So, for each line that starts at the term indent, estimate the definition column from the nearest lines on the same page (definition-only lines, or term lines with a clear gap), then split at a gap of two or more spaces near that column, or failing that at the word boundary closest to it (a long term can run up to one space short of its definition). Lines indented past the term indent are definition-only. A term-level line starts a **new entry** when the previous line was definition-only, or the term so far ends with a parenthesised abbreviation such as `(CMS)`, or the definition so far ends a sentence and the new fragment starts with a capital; otherwise it continues the current term (term names wrap over several lines). Repeated `Term   Definition` rows at page tops are skipped. Rebuild each entry as `Term: definition…`, one block per page it spans. Footers can take three lines (`GG.1330: <title>` above `Page 19 of 19`), and one policy (GG.1815) has stray numbering (`XI.  Member …`) in front of its terms; both are stripped. For the `DEFINITIONS` format (AA.1000 style), an entry starts at a line matching `^[A-Z0-9][^:]{1,80}:\s`.

**References.** From the `references` section collect every APL number matching `APL\)?\s*(\d{2}-\d{3})` into `referencedApls`.

**Canonical text.** Build the text the models will read and that quotes are verified against:

```
[[GG.1503 | CalOptima Health Hospice Coverage, Notification and Validation Requirements | Applies to: Medi-Cal, OneCare | Revised 09/01/2024]]
<<page 1>>
I. PURPOSE
…original lines, footers removed, indentation reduced to 2 spaces per level…
IX. GLOSSARY
Authorized Representative: Medi-Cal: Any individual appointed…
```

- `admin` sections are **omitted** from canonical text. `references` is kept.
- `<<page N>>` markers appear on their own lines at each page start.
- Store `canonicalText`, and an `offsets` array mapping character ranges → `{ page, address, kind, scope }`.
- Store `tokenEstimate = ceil(canonicalText.length / 4)`.

**Output shape**

```ts
type Policy = {
  id: string; title: string; department: string; section: string;
  effectiveDate: string | null; revisedDate: string | null;   // ISO yyyy-mm-dd
  programs: { mediCal: boolean; oneCare: boolean; pace: boolean; administrative: boolean };
  pageCount: number; referencedApls: string[];
  canonicalText: string; tokenEstimate: number;
  spans: { start: number; end: number; page: number; address: string;
           kind: "body" | "glossary" | "references"; scope: "medi-cal" | "other" | "both" }[];
  outline: { address: string; firstLine: string; pageStart: number; pageEnd: number }[];
};
```

`library.json` holds the header fields of all policies (no text) plus counts.

### 5.3 APL (`apl.ts`) → `public/data/apl/APL25-008.json`

Per-page text (drop the `APL 25-008` / `Page N` header lines and footnote URL lines are kept). Metadata from page 1: `number` ("25-008"), `subject`, `date` (ISO), `supersedes` (["13-014"]). Mark it `kind: "regulator"`; it is never searched or cited as plan evidence.

### 5.4 Questionnaire (`questionnaire.ts`) → `public/data/questionnaires/apl-25-008.json`

**Questions.** From the layout text:
- Remove noise lines: `Rev. 08/2023`, lines that are only `Yes   No`, and lines starting with `Citation`.
- A question starts at `^\s*(\d{1,2})\.\s+Do(es)?\b` and ends at its `(Reference: APL 25-008, page(s) X[-Y])` line. Join the lines between into one string.
- Parse `aplPages` from the reference (`pages 6-7` → `[6, 7]`).
- Assert exactly **64** questions, numbered 1–64 in order.
- From page 1 read the `SUBMISSION ITEM` line to get the APL number and subject.

**Form field map.** With `pdf-lib`, list every widget with its page, rectangle, field name, field type and on-states.
- **Citation fields:** all text fields except those on page 1 whose top edge is above y = 300 (the header block). Sort by page, then top-to-bottom. Expect **64**; the *n*th is question *n*'s citation field.
- **Yes/No pairs:** group button widgets into rows (same page, y within 6 pt) that contain a left widget near x ≈ 37 and a right widget near x ≈ 91, below the header block. Sort the rows by page, then top-to-bottom. Expect **64**; the *n*th row is question *n*. For each row, record every widget in it (the form has both a radio pair and an overlapping checkbox pair): `{ fieldName, fieldType: "radio" | "checkbox", widgetIndex, onState, side: "yes" | "no" }`. The stored map is `formMap: { number, citationField, yesNo: [...] }[]`. Self-check: the form's radio states are named `Yes_<n>` / `No_<n>`; where present, `<n>` must equal the question number (it does for all 63 rows that have one).
- A Yes/No row can sit at the bottom of one page with its citation field at the top of the next. Zipping the two sorted lists by index handles this.
- If either count is not 64, write `formMap: null` and print a warning. The app then offers only the CSV export.

### 5.5 Policy Guide (`guide.ts`) → `public/data/guides/ecm-2026-01.json`

1. Read bookmarks with `pdfjs-dist` (`getOutline`, resolve each destination to a page). Drop wrapper titles (`ECM-Policy-Guide-January-2026`, `ECM-Policy-Guide-January-2026.pdf`, `CALAIM ENHANCED CARE MANAGEMENT POLICY GUIDE`, `ECM Policy Guide Edits`, `TABLE OF CONTENTS`, a bare `(Updated January 2026)`) and entries with no page. 156 headings remain. Keep each heading's depth and build its `path` (titles of its ancestors).
2. Extract page text with `pdftotext -layout`. **Lift out footnotes first:** each page's footnotes sit at the bottom as a number alone on a line (at the left margin, numbered consecutively through the document, 1–90) followed by text. Left in place they cut sentences that continue on the next page. Remove them from the page and re-attach them at the end of the section that is open at the bottom of that page, under a `Footnotes:` line, as `[Footnote 14, p.17] …`. Then drop lines that are only a page number.
3. Locate each heading in its page's text (whitespace-insensitive match of the title). If not found, use the top of the page.
4. **Extra section starts:** every line that begins with `(Updated <Month> <Year>)` and is not already a located heading becomes a section start. Its title is the line up to the first `:` (or the whole line). Its `path` is the path of the closest preceding bookmark heading. This catches the 13 inserted pages with no bookmarks (for example page 17, "Community Supports").
5. Sort all starts by (page, line). A section's text runs to the next start. Drop sections with fewer than 20 words (pure headings); their titles remain in children's paths. A bare `(Updated January 2026)` line is not a start; it belongs to the heading around it. Every path begins at its chapter (`IV. ECM POPULATIONS OF FOCUS`). Result for this Guide: 141 sections (156 bookmark headings + 5 marker starts − 20 pure headings), 21 flagged Updated.
6. For each section store: `id`, `title`, `path`, `pageStart`, `pageEnd`, `updated` (title or first line contains `(Updated`), `source` (`bookmark` or `marker`), `wordCount`, `text` with `<<page N>>` markers, and `parentIntro` (first paragraph of the nearest ancestor that has text, max 120 words; resolve each ancestor by searching **backwards** from the section, because titles such as `C. Operational Guidance:` repeat).

### 5.6 Search index (`searchIndex.ts`) → `public/data/search-index.json`

One MiniSearch document per outline item of every **Medi-Cal** policy (merge items under 25 words into the previous sibling; one document per glossary entry). Fields: `text` (number-normalized, see §7.1) and `label` (`<ID> · <title> · <ancestor first lines>`). Stored fields: `policyId`, `address`, `page`. Serialize with `toJSON`.

### 5.7 Acceptance checks (`report.ts` must print PASS for each)

- 373 policies parsed, 373 unique IDs, 251 with `programs.mediCal`.
- `MA.6113`: `mediCal` false. `GG.1503`: `mediCal` true, `revisedDate` 2024-09-01, `referencedApls` includes `13-014`, 18 pages.
- `GG.1503` has addresses `II.B`, `II.C`, `II.C.2`, `II.I`, `III.F.1`; `II.B` scope `other`; `II.C` scope `medi-cal`.
- `GG.1503` canonical text contains a glossary entry starting `Hospice Care: The provision of palliative` that includes `12. Any other palliative item`.
- Canonical text of `GG.1503` contains `no later than thirty (30) calendar days` mapped to address `III.F.1`.
- Questionnaire: 64 questions; Q25 `aplPages` = [6, 7]; form map has 64 citation fields and 64 Yes/No rows.
- APL: 17 pages; `supersedes` = ["13-014"]; `date` = 2025-05-05.
- Guide: between 120 and 200 sections (141 measured); at least 20 flagged `updated`; every bookmark heading located in the text; a section titled like `(Updated January 2026) Community Supports` on page 17 whose text contains `Transitional Rent`.
- Exact search for `transitional rent` over all policies returns 0 hits.

---

## 6. Model settings (`src/config/models.ts`)

This is the **only** place a model is named.

```ts
export const MODELS = {
  haiku: { id: "claude-haiku-5-5", label: "Standard",
           price: { input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.01 } },   // $ per million tokens, prompts ≤ 100k
  opus:  { id: "claude-opus-5-5",  label: "Maximum accuracy",
           price: { input: 4.00, output: 20.00, cacheWrite: 5.00, cacheRead: 0.20 } },
} as const;

export const TASKS = {
  checklist:        { model: "haiku", effort: "high", maxTokens: 4000,  uiToggle: false },  // Step 7
  readEveryPolicy:  { model: "haiku", effort: "low",  maxTokens: 1500,  uiToggle: false },  // Step 9
  fullReading:      { model: "haiku", effort: "high", maxTokens: 8000,  uiToggle: true  },  // Step 11
  secondOpinion:    { model: "haiku", effort: "high", maxTokens: 6000,  uiToggle: true  },  // Step 13
  findObligations:  { model: "haiku", effort: "high", maxTokens: 6000,  uiToggle: false },  // Step 22
} as const;
```

`src/config/pipeline.ts`:

```ts
export const PIPELINE = {
  bundles: 3,                 // Step 9: checklist bundles per questionnaire
  maxPolicyTokensPerCall: 60_000,
  longPolicyTokens: 25_000,   // above this, send excerpts instead of the whole policy
  maxChunksPerGroup: 3,
  concurrency: 6,             // parallel API calls
  keywordHitsPerItem: 2,
  maxGroupSize: 7,            // questions per group (Steps 11–15)
  commonTermPolicies: 15,     // an exact search term found in more policies than this is ignored
  promptVersion: "v1",        // bump to invalidate saved calls
};
```

The UI toggles override `fullReading.model` and `secondOpinion.model` for the next run only. They reset to these defaults on reload.

---

## 7. Shared code

### 7.1 Text utilities (`lib/text.ts`)

- `normalize(s)`: remove `<<page N>>` markers; replace curly quotes and dashes with plain ones; join words hyphenated across line breaks; collapse all whitespace to single spaces; lower-case. Also return a map from normalized offsets back to original offsets.
- `normalizeNumbers(s)`: turn `five (5)` and `five` into `5` for number words one–ninety-nine and `hundred`; `percent` and `%` → `percent`.
- `extractQuantities(s)`: after `normalizeNumbers`, find `<number> <unit>` where unit ∈ calendar day(s), business day(s), working day(s), day(s), hour(s), month(s), year(s), percent, visit(s). Return `{ value, unit, unitBase }` where `unitBase` ∈ day, hour, month, year, percent, visit.
- `estimateTokens(s) = ceil(s.length / 4)`.

### 7.2 Quote verification (`lib/quotes.ts`)

`verifyQuote(policy, quote) → { status: "exact" | "corrected" | "rejected", text, page, address, kind, scope }`

1. Normalize the quote and the policy's canonical text. If the quote occurs, status `exact`. Take the **source** text for that range (not the model's text), and look up page, address, kind and scope from `spans` at the range start. If the same words occur in several places (GG.1503 §II.B.3 and §II.C.3 are identical), prefer an occurrence that can be cited: not scoped to another program and not in References.
2. Otherwise find the window of the canonical text most similar to the quote: anchor on any 5-word run of the quote that occurs in the policy, try windows of the quote's length ±20% around it, and compare word by word (edit distance, ignoring punctuation around words). If similarity ≥ 0.90, status `corrected` and use the source text of that window.
3. Otherwise `rejected`.

Quotes must be contiguous source text, at most 80 words, with no ellipses. The prompts say so.

### 7.3 Search (`lib/search.ts`)

- `exactSearch(phrase, { mediCalOnly })`: scan every loaded policy's normalized, number-normalized canonical text for the normalized phrase. Return `{ policyId, address, page, snippet }[]`. Policies are loaded once into memory at app start (about 8 MB of JSON; show a loading bar).
- `keywordSearch(query, k)`: MiniSearch query over the prebuilt index, Medi-Cal only.

### 7.4 LLM client (`llm/client.ts`, `llm/cache.ts`)

```ts
callLLM({ task, model?, system, messages, schema }) → { data, usage, fromSavedCache }
```

- `POST https://api.anthropic.com/v1/messages` with headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`, `anthropic-dangerous-direct-browser-access: true`.
- Model ID, `max_tokens` and effort come from `TASKS[task]` (or the override). **Confirm the exact request fields for thinking/effort for these models in the API docs (https://docs.claude.com) and set them in this one file.** If unsure, omit effort for `low` and enable the documented adaptive/extended thinking option for `high`.
- **Output format:** every prompt ends with "Return only a JSON object inside `<json></json>` tags." Extract the last `<json>` block from the text output, `JSON.parse`, validate with the task's zod schema. On failure retry once with the validation error appended as a new user turn. On second failure throw; the pipeline marks the affected items `needs_review` with reason "model output unreadable".
- **Prompt caching:** callers mark the end of the shared prefix with `cache_control: { type: "ephemeral" }` (see each step). Nothing else.
- **Saved-call cache:** key = SHA-256 of `{ modelId, promptVersion, system, messages, maxTokens, effort }`. Look up in IndexedDB before calling; store `{ data, usage }` after. A hit returns immediately with `fromSavedCache: true` and zero cost. This single mechanism gives resume-after-refresh, free re-runs of unchanged steps, and instant reopening of Guide sections.
- **Concurrency and retries:** a shared queue with `PIPELINE.concurrency` workers. On HTTP 429 or 529 or a network error, back off (honour `retry-after`, else 2s, 4s, 8s, 16s, 32s) up to 6 tries.
- **Usage:** record `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` per call and convert to dollars with `MODELS[...].price`. Each run keeps a running total per task.
- **Cache warm-up rule:** when many calls share a cached prefix, send the **first call alone and wait for it to finish**, then release the rest in parallel. Otherwise parallel calls all pay the cache-write price.

---

## 8. The pipeline

Step numbers match the product walkthrough. Steps 1–5 are the prep pipeline (§5). Step 6 is the upload/confirm screen (§10.3).

### Core types

```ts
type Quantity = { value: number; unit: string; unitBase: string };

type Item = {                     // one thing that must be proven
  id: string;                     // "Q25-03" or "OBL-<sectionId>-02"
  parentId: string;               // question number or obligation id
  requirement: string;            // one self-contained sentence
  quantities: Quantity[];         // numbers essential to the requirement
  searchTerms: string[];          // 0–4 distinctive exact phrases/codes, e.g. "0657", "election form"
  allowsReference: boolean;       // true for "P&P may reference X" items
};

type Evidence = { policyId: string; quote: string; page: number; address: string;
                  kind: string; scope: string; status: "exact" | "corrected" };

type ItemStatus = "covered" | "not_covered" | "conflict" | "needs_review";

type ItemResult = {
  item: Item; status: ItemStatus; evidence: Evidence[];
  readerReason: string; reviewer: { agrees: boolean; reason: string } | null;
  flags: Flag[];                  // see Step 12
  trail?: SearchTrail;            // Step 14
};

type Verdict = "conflict" | "needs_review" | "partial" | "not_found" | "covered";

type ParentResult = {             // one question or one obligation
  parentId: string; verdict: Verdict; items: ItemResult[];
  suggestedAnswer: "yes" | "no" | null; suggestedCitation: string;
  approved: boolean; edited?: { answer: "yes" | "no"; citation: string };
};
```

### Step 7 — Checklist (`checklist.ts`, task `checklist`)

One call per question.

- **System (cached, identical for all 64 calls):** instructions below.
- **User:** the question text, then the text of its `aplPages` from the APL.

Instructions (give these to the model in substance):

> You turn one DHCS review question into a checklist. Split it into the smallest separate requirements that a policy document must state. Each requirement must be one self-contained sentence that makes sense without the question. If the question refers to a list that it does not spell out ("the 12 listed services", "the five listed documents"), find that list in the APL pages provided and create one item per list entry, copying each entry faithfully. For each item also give: `quantities` (numbers with units that are essential, e.g. 5 calendar days); `searchTerms` (up to 4 short exact phrases or codes that a matching policy would very likely contain); `allowsReference` (true only if the question says the P&P "may reference" a document). Also return `listCount` if the question names a count ("12 listed"), else null. Do not judge compliance.

Output schema: `{ items: { requirement, quantities, searchTerms, allowsReference, fromList: boolean }[], listCount: number | null }`.

Code check: if `listCount` is set and the number of `fromList` items differs, retry once; if still different, keep the items and add flag `list_count_mismatch` to the question.

### Step 8 — Grouping (`grouping.ts`, plain code)

- **Groups** (used by Steps 11–15): walk questions in order and start a new group when adding the next question would exceed 7 questions, or when its first APL page is more than 1 page past the group's first APL page. Expect about 10 groups.
- **Bundles** (used by Step 9): split the ordered item list into `PIPELINE.bundles` contiguous parts of roughly equal item count, never splitting a question across bundles.
- For a Guide section check there is one group and one bundle.

### Step 9 — Read every Medi-Cal policy (`readEveryPolicy.ts`, task `readEveryPolicy`)

For each bundle, one call per Medi-Cal policy (251 × bundles calls).

- **System (cached per bundle):** instructions + the bundle's items as `ID: requirement` lines. `cache_control` on this block. Apply the warm-up rule.
- **User:** the policy's full `canonicalText`.

Instructions:

> You are screening one policy document. Below are numbered requirements. Report which requirements this policy addresses, even partly, and where. If you are unsure, include it. Give the section address as written in the document (for example "II.C.2" or "Glossary: Hospice Care"). Mark `strength` "direct" if the policy clearly speaks to the requirement, "maybe" if it is only related. If none apply, return an empty list. Do not explain.

Output: `{ hits: { itemId, address, strength: "direct" | "maybe" }[] }`.

Record a completion flag for every (policy, bundle). Step 14 depends on it.

### Step 10 — Combine candidates (`candidates.ts`, plain code)

For each item, a policy is a candidate if any of these is true (record which, as `foundBy`):

- `haiku-direct` / `haiku-maybe`: a Step 9 hit.
- `exact`: `exactSearch` hit for one of the item's `searchTerms` (terms shorter than 4 characters are searched only together with the word that follows them in the requirement; a term found in more than `commonTermPolicies` policies is too common and is ignored; hits in other-program text, or in References for items that do not allow references, do not count).
- `keyword`: in the top `keywordHitsPerItem` policies for `keywordSearch(requirement)`.

Only Medi-Cal policies. Then, per group:

1. Score each candidate policy: 3 per `haiku-direct` item, 2 per `exact`, 1 per `haiku-maybe`, 1 per `keyword`.
2. **Long policies:** if `tokenEstimate > longPolicyTokens`, do not send the whole policy. Send excerpts: the header line plus every lettered section (or glossary entry) that contains a hit address or a search hit, each prefixed with its address and page marker.
3. Pack policies in score order into chunks of at most `maxPolicyTokensPerCall`. Policies with any `haiku-direct` or `exact` hit are always included, adding chunks as needed. Policies with only `haiku-maybe` or `keyword` hits fill remaining space, up to `maxChunksPerGroup` chunks. Anything left out is recorded in `skippedCandidates` and shown in the search trail.
4. Each chunk lists which items it can serve (items with a candidate in that chunk).

### Step 11 — Full reading (`fullReading.ts`, task `fullReading`)

For each group, for each chunk, one call per question that has at least one item served by that chunk.

Message layout (this exact order makes caching work, and is shared with Step 13):

1. **System:** a short generic block, identical for Steps 11 and 13:
   > You are a careful compliance analyst for a Medi-Cal managed care plan. You will be given the plan's policy documents and regulator text, followed by a task. Policy text is evidence. Regulator text is never evidence. Quote only exact, contiguous text from the policy documents.
2. **User content block 1:** the chunk's policies (canonical text, each starting with its `[[…]]` header line), then the group's APL pages under a heading `REGULATOR TEXT (APL 25-008) — not evidence`. `cache_control` at the end of this block. Apply the warm-up rule per chunk.
3. **User content block 2:** the task: instructions, then the question text and its items.

Task instructions:

> For each requirement, decide whether the policy documents state it. Rules: (1) Evidence must come from a policy that applies to Medi-Cal and from text that applies to Medi-Cal members; text under a Medicare-only or OneCare-only heading does not count. (2) Read whole documents: check definitions, and look for conditions, exceptions or other passages that narrow or contradict the evidence. (3) Different wording is fine only if it means the same thing; say so in the reason. (4) If the policy states something incompatible with the requirement (for example a different deadline), the status is "conflict" and you must quote the conflicting text. (5) If a requirement includes a number or deadline, the quote must show it. (6) Quotes must be exact contiguous text, at most 80 words each, no ellipses, at most 3 per requirement. (7) If nothing in the documents states it, the status is "not_covered". Do not guess.

Output: `{ items: { itemId, status: "covered" | "not_covered" | "conflict", wording: "same" | "equivalent", evidence: { policyId, quote }[], reason: string }[] }` (reason ≤ 40 words). `wording` is "equivalent" when the policy uses different terms from the requirement (for example "hospice physician" for "hospice medical director"); the reason must then name both terms. A `covered` item with `wording: "equivalent"` gets flag `wording_differs`. It stays `covered`, but it sorts above other covered answers so Alex confirms the judgment call herself.

Merging across chunks: for each item keep the best status in the order conflict > covered > not_covered, and pool the evidence.

### Step 12 — Automatic checks (`checks.ts`, plain code)

For every piece of evidence:

1. **Quote exists.** `verifyQuote`. `rejected` quotes are removed. `corrected` adds flag `quote_corrected`.
2. **Program and section.** Remove the quote if the policy is not Medi-Cal, if `scope === "other"`, or if `kind === "references"` and the item is not `allowsReference`. Removal for scope adds flag `wrong_program_removed`.
3. If a `covered` or `conflict` item has no evidence left, it becomes `not_covered`.

Then per item:

4. **Numbers.** For each `quantity` in the item, look through the item's quotes (`extractQuantities`). 
   - A quote has the same value and `unitBase` → fine.
   - No quote has that value, but a quote has the same `unitBase` with a different value → flag `number_mismatch` with both values. If the status was `covered`, it becomes `needs_review`.
   - No quote has any quantity of that `unitBase` → flag `number_not_shown`. If the status was `covered`, it becomes `needs_review`.
5. **Outdated policy.** For each cited policy: flag `policy_predates_apl` if `revisedDate` < APL date; flag `cites_superseded_apl` if `referencedApls` intersects the APL's `supersedes`. These do not change status. (For Guide checks, use the Guide's date, 2026-01-01, and skip the superseded check.)

`Flag = { code, detail }`.

### Step 13 — Second opinion (`secondOpinion.ts`, task `secondOpinion`)

Runs **immediately after** Steps 11–12 for the same chunk, one call per question, so the cached prefix is still live.

- System and user block 1: **byte-identical** to Step 11's for that chunk. If the two toggles select the same model, this reads Step 11's cache. If they differ, apply the warm-up rule again (the UI warns about the extra cost).
- User block 2: the question, its items, and for each item the **post-check** status, the verified quotes with addresses, and the flag codes. **Do not include the first reader's `reason`.**

Instructions:

> Another analyst proposed the answers below. Your job is to find reasons each answer is wrong. For "covered" or "conflict": does the quoted text really prove the whole requirement? Is its scope narrower? Does another passage add a condition or exception? Is it the right program? For "not_covered" or "needs_review": search the documents for evidence that was missed, and quote it exactly. Answer for every requirement.

Output: `{ items: { itemId, agrees: boolean, proposedStatus: "covered" | "not_covered" | "conflict", reason: string, newEvidence: { policyId, quote }[] }[] }`.

Resolution (plain code). First run `newEvidence` through Step 12's checks 1–2.

| Reader status (after checks) | Reviewer | Result |
|---|---|---|
| covered | agrees | covered |
| covered | disagrees | **not_covered**, flag `reviewer_disputed` (the cautious status wins). Keep the quotes and show them as "disputed evidence" so Alex can overrule. |
| conflict | agrees | conflict |
| conflict | disagrees | needs_review, flag `reviewer_disputed` |
| not_covered | agrees | not_covered |
| not_covered | disagrees with verified new evidence | needs_review, attach the evidence, flag `reviewer_found_evidence` |
| not_covered | disagrees without verified evidence | not_covered |
| needs_review | any | needs_review (attach verified new evidence) |

### Step 14 — Prove "not found" (`notFound.ts`, plain code)

For every item that is `not_covered` with no evidence:

1. Check that Step 9 completed for all 251 policies for the item's bundle. Re-run any missing calls.
2. Run `exactSearch` for each search term and `keywordSearch(requirement, 5)`. If this finds a Medi-Cal policy that was not sent to Step 11 for this item, run Steps 11–13 once more for that item with those policies (one extra chunk). Record `rescued: true` if the status changes.
3. Otherwise attach the trail:

```ts
type SearchTrail = {
  policiesRead: number;                       // 251
  exactTerms: { term: string; hits: number }[];
  closest: { policyId: string; title: string; address: string; page: number } | null;  // top keyword hit
  skippedCandidates: string[];                // from Step 10, usually empty
};
```

### Step 15 — Verdicts (`verdicts.ts`, plain code)

Per question or obligation, from its item statuses:

| Verdict | Rule (first match wins) |
|---|---|
| `conflict` | any item is `conflict` |
| `needs_review` | any item is `needs_review` |
| `not_found` | every item is `not_covered` |
| `partial` | some items `covered`, some `not_covered` |
| `covered` | every item is `covered` |

- `suggestedAnswer`: `covered` → yes; `conflict`, `not_found` → no; otherwise null.
- `suggestedCitation`: distinct `<policyId> §<address>, p.<page>` of the covered items' first quotes, joined with `; `, shortest addresses first. The form's field is one line: include whole citations while the total stays under 90 characters and never cut one in the middle. The full list is always in the CSV.
- **Sort order for display:** conflict, needs_review, partial, not_found, covered; within a verdict, more flags first; then question number.

### Orchestration (`runQuestionnaire.ts`)

1. Step 7 for all questions (parallel).
2. Step 8.
3. Step 9 for all bundles. Progress: "Read N of 753".
4. Step 10.
5. For each group, in order, with groups running in parallel up to the concurrency limit: Steps 11 → 12 → 13 → 14 → 15, then **publish that group's results to the store** so the UI can show them while later groups run.
6. Save the run (§9.2).

A run can be cancelled. Because every call is in the saved-call cache, starting it again resumes where it stopped at no cost.

### Step 22 — Find obligations (`findObligations.ts`, task `findObligations`)

Plain code first splits the section text into sentences (split on `. `, `; ` before a capital, and at each `»` bullet), numbers them `[S1] …`, and marks **cue sentences**: those matching `\b(must|shall|required|requires|may not|must not|should|encouraged|expected to|are expected|is expected)\b`.

One call:
- **System:** instructions (cached; shared by all sections).
- **User:** heading path, `parentIntro`, then the numbered sentences with page markers, then the list of cue sentence IDs.

Instructions:

> You extract obligations from one section of a DHCS Policy Guide. An obligation is something a managed care plan (MCP) or its providers must or should do. One sentence may contain several obligations; create one per distinct duty. Do not create obligations for things DHCS itself will do, for background, or for examples. For each obligation give: `summary` (one plain sentence, self-contained, starting with who must act); `actor` ("plan", "provider" or "other"); `strength` ("binding" for must/shall/required/may not; "recommended" for should/encouraged/expected); `sentenceIds` (the source sentences); `quantities`; `searchTerms` (up to 4 distinctive exact phrases). Then, for every cue sentence ID that you did not use, give a reason of at most 12 words in `nonObligations`.

Output: `{ obligations: {…}[], nonObligations: { sentenceId, reason }[] }`.

Code checks: every `sentenceId` must exist; every cue sentence must appear in an obligation or in `nonObligations` (if any are missing, retry once listing them; any still missing are stored as `unexplained`). The obligation's source text and page come from the numbered sentences, so they are exact by construction.

Each obligation becomes one `Item` (`requirement` = `summary`, `allowsReference` false).

### Step 24 — Check a section (`runSectionCheck.ts`)

Input: the ticked obligations of one section. Run Step 8 (one bundle, one group), Step 9 (251 calls), Steps 10–15, with these differences: there is no APL; user block 1 puts the section text under `REGULATOR TEXT (ECM Policy Guide) — not evidence`; each obligation is one "question" with one item.

---

## 9. Caching and saved data

### 9.1 Prompt caching (inside a run)

| Step | Cached prefix | Reused by |
|---|---|---|
| 7 | System instructions | 64 calls |
| 9 | System instructions + the bundle's items | 251 calls per bundle |
| 11 + 13 | System + chunk policies + regulator text | every question in the group, in both steps |
| 22 | System instructions | every section |

Rules: the cached part comes first and is byte-identical; warm up with one call before going parallel; Step 13 runs right after Step 11; the cache only helps when both use the same model.

### 9.2 Saved results (between runs)

- **Saved-call cache** (§7.4): every API call, keyed by its full request. This is what makes re-runs cheap.
- **Runs** (IndexedDB): `{ id, kind: "questionnaire" | "section", sourceId, createdAt, models: { fullReading, secondOpinion }, cost, usageByTask, results: ParentResult[], foundByLog }`. Approvals and edits are written into the run as Alex works.
- **Guide sections** (IndexedDB): obligations per section, and the latest check run per section.
- **Settings** (`localStorage`): API key.

Re-running with a different toggle creates a **new run**. Unchanged steps hit the saved-call cache and cost nothing (for example switching only Second opinion to Opus re-pays only Step 13, plus cache-writing the policies for Opus).

### 9.3 Demo replay

Settings has "Export this run as a demo file", which downloads the run as JSON. Files placed in `public/demo/` and listed in `public/demo/index.json` are loaded at start as read-only runs. This lets the hosted site show full results to someone with no API key. Live runs still need a key.

---

## 10. User experience

### 10.1 Principles

1. Show the evidence, not just the answer.
2. Riskiest answers first.
3. Never leave her waiting with nothing to do: results appear group by group.
4. She stays in control: nothing reaches the DHCS form until she approves it.
5. Show what was checked: "Read all 251 Medi-Cal policies", and a search trail for every Not found.
6. Price before the click: every Run button shows estimated cost and time.

Language in the UI is plain: "policies", "checks", "second opinion". No model jargon except the small model name under each accuracy option.

### 10.2 Shell

- Header: product name, plan name ("CalOptima Health"), **Accuracy** control, Settings.
- **Accuracy control:** two switches, "Full reading" and "Second opinion", each Standard (Haiku) ↔ Maximum accuracy (Opus). Disabled during a run. If they differ, show: "Using different models loads the policies twice. The extra cost is included in the estimate."
- **Settings:** API key field (stored only in this browser, with a line saying so), a "Test key" button (one tiny call), "Clear saved results", "Export this run as a demo file".
- If there is no API key, Run buttons are replaced by "Add your API key to run live" and any demo runs are still viewable.

### 10.3 Screens

**Home (`/`)**
- Library card: "Library ready · 373 policies (251 Medi-Cal) · APL 25-008 loaded".
- Two large actions: **Answer a DHCS questionnaire** and **Review a Policy Guide**.
- Recent runs list (date, models, verdict counts, cost).

**Questionnaire start (`/questionnaire/apl-25-008`)** — Step 6
- "APL 25-008: Hospice Services and Medi-Cal Managed Care · 64 questions · ✓ APL found in library".
- Current accuracy settings.
- Button: **Run · ≈ $0.95 · about 5 minutes** (from `estimate.ts`).

**Run progress** (same route, while running)
- Checklist of stages with live counts:
  - ✓ Turned 64 questions into N checks
  - ✓ Read all 251 Medi-Cal policies (n / 753)
  - ▸ Reading candidate policies in full: group g of G
  - ▸ Second opinion and final checks
- Running cost so far.
- Button appears as soon as one group is done: **Start reviewing — n answers ready**. Cancel button.

**Results (`/run/:runId`)** — Step 16
- Summary bar: "64 questions · Conflict a · Needs review b · Partial c · Not found d · Covered e · Read all 251 Medi-Cal policies · Standard / Standard · $0.94".
- Filter chips per verdict. Default sort is riskiest first.
- Row: question number, first ~120 characters of the question, verdict chip, top citation, small flag chips (labels: `wording_differs` → "wording differs", `number_mismatch` → "numbers differ", `number_not_shown` → "number not shown", `reviewer_disputed` → "second opinion disagreed", `reviewer_found_evidence` → "second opinion found evidence", `policy_predates_apl` / `cites_superseded_apl` → "policy may be outdated", `quote_corrected` → "quote corrected", `wrong_program_removed` → "non-Medi-Cal text removed", `list_count_mismatch` → "list may be incomplete").
- Progress: "n of 64 approved". Buttons: **Fill DHCS form**, **Download CSV**.
- If another run exists for the same questionnaire: **Show differences** lists questions whose verdict differs between the two runs, side by side.
- Re-run button reflecting the current toggles, with its estimate.

**Question detail (`/run/:runId/q/:n`)** — Step 17. Split view.
- Left panel:
  - Question text and its reference.
  - Collapsible "What DHCS requires": the text of the cited APL pages.
  - Checklist: every item with a status icon and its requirement. Under each: quotes (each a clickable card showing `GG.1503 §II.C.2 · p.2`), the reader's one-line reason, the second opinion ("Agrees" or its reason), flags with their detail (for `number_mismatch`: "Requirement: 5 days · Policy: 30 days").
  - For items with no evidence: the search trail ("Read all 251 Medi-Cal policies · 'election form': 4 hits, none matching · Closest: GG.1503 §III.F, p.9") with the closest policy clickable.
  - Suggested answer (Yes / No / unset) and citation text, both editable.
  - Actions: **Approve & next** (goes to the next unapproved result in risk order), **Flag for follow-up** (with an optional note, shown in the results table and the CSV). Approve is disabled until Yes or No is chosen; for Partial and Needs review nothing is pre-selected, so she must decide. An approved answer shows **Reopen**, which un-approves it.
  - Keyboard: `J` / `K` next and previous result, `Y` / `N` set the answer, `A` approve & next. Show the shortcuts in a small hint line.
  - Header of the panel: "Question 11 of 64 · 3 approved" with previous / next arrows and a back link to the results table.
- Right panel: PDF viewer on the cited policy, at the cited page. Try to highlight the quote: find the text-layer spans whose joined text contains the first 8 words of the quote (whitespace-insensitive) and give them a highlight class. If not found, just show the page with a note "Quote is on this page". Page controls and a link to open the PDF in a new tab.

**Guide (`/guide/ecm-2026-01`)** — Steps 21–25. Three columns.
- Left: table of contents (indented by path depth), page ranges, **Updated** badges, a status dot per section (not reviewed / obligations found / checked), "Show Updated only" switch, and "Updated sections reviewed: n of N".
- Middle: section text. After Step 22, cue sentences are highlighted: green if used by an obligation, yellow if not (hover shows the reason; `unexplained` ones show "Not explained — please read").
- Right:
  - Before: **Find obligations · < $0.01**.
  - After: obligation cards (summary, Binding/Recommended chip, page, checkbox ticked by default). Clicking a card scrolls to and outlines its sentences. "Re-run" link.
  - **Check n obligations · ≈ $0.17**.
  - After the check: each card shows a verdict chip and citation; Not found shows "Closest policy: GG.1355 §II.I, p.2". Clicking a card opens the same detail view as the questionnaire (route `/run/:runId/q/:n`).

### 10.4 States every screen must handle

- **Loading the library** (first seconds after opening): a progress bar, "Loading 373 policies…". Nothing else is clickable until it finishes.
- **No API key:** saved and demo runs are fully viewable; Run buttons read "Add your API key to run live" and open Settings.
- **Bad key or no credit** (HTTP 401 / 403 / 400 billing): stop the run at once and show one plain message with a button to Settings. Do not retry.
- **Slow run** (rate limited): the progress screen says "The API is limiting our speed. Still working; nothing is lost." Never show raw error text.
- **Interrupted run** (tab closed, network lost, cancelled): Home shows it as "Paused · 31 of 64 answers ready" with **Resume** (free for finished work, thanks to the saved-call cache) and **Open results so far**.
- **A step failed for some questions:** those questions appear as Needs review with the reason "Could not be analysed — retry", and a **Retry these** button. The rest of the run is unaffected.
- **Results arriving while she reviews:** new rows are added without reordering what is on screen. A banner says "12 more answers ready — refresh list".
- **Verdict chips** always carry a text label and an icon, never colour alone.
- **Privacy line** in the footer and in Settings: "Your policies stay in this browser. Text is sent only to the Anthropic API for analysis, using your own key."
- **Everything is reversible** except running a paid step: approvals can be reopened, edits can be reset to the suggestion, and the filled form can be exported again at any time.

### 10.5 Estimates (`pipeline/estimate.ts`)

Simple formulas from config and prices; show one significant range, e.g. "≈ $0.95".

- Step 9: `bundles × 1.2M × input + calls × 400 × output` (+ small cached prefix).
- Steps 11+13: per group `50k × cacheWrite`, per call `50k × cacheRead + 2.5k × input + 3k × output`; if the two models differ, add a second cache write per group.
- Time: `calls / (concurrency × 0.5 calls per second)`, rounded up to whole minutes, shown as "about N minutes".
- After a run, always show the **actual** cost from recorded usage.

---

## 11. Export (Step 18, `export/fillForm.ts`)

- Load `public/pdfs/questionnaires/apl-25-008.pdf` with `pdf-lib`.
- For each **approved** result with an answer: set the citation text field to the citation (font size auto); for the Yes/No row, turn on every widget on the chosen side and off on the other side, using the `formMap` from prep (for radio groups call `select(onState)`; for checkboxes `check()` / `uncheck()`).
- Unapproved questions are left blank. Before export, show "n questions not yet approved" with Continue / Cancel.
- Download as `APL-25-008-Submission-Review-Form-filled.pdf`.
- **CSV export** (always available): question number, verdict, answer, citation, quotes, flags.
- If `formMap` is null, hide "Fill DHCS form".

---

## 12. Accuracy page (dev only, `/dev/eval`)

Used to produce the numbers for the demo video.

- `src/eval/labels.json` (filled in by hand): `{ question: number, expectedVerdict: Verdict, expectedPolicies: string[], notes: string }[]`. Ship it with entries for Q10, Q11 and Q25 as examples and leave the rest for the author.
- "Run labeled questions": runs the normal pipeline on just those questions.
- "Run naive baseline": for each labeled question, one call with `GG.1503` + `GG.1550` full text and the prompt "Does the P&P state this? Answer yes or no with a citation." No checklist, no checks.
- Table: per question — expected vs pipeline verdict vs baseline answer; whether every expected policy was a candidate and which layer found it (`foundBy`); count of wrong "covered"; percentage of quotes that were `exact`.

---

## 13. Build order and acceptance

Build in this order. Do not start a phase until the previous one passes.

1. **Prep.** `npm run prep` prints PASS for every check in §5.7.
2. **Shared code + unit tests.** `text.ts`, `quotes.ts`, `checks.ts`, `verdicts.ts`, `grouping.ts`, `candidates.ts` have Vitest tests. Required cases: `normalizeNumbers("five (5) calendar days")` → `5 calendar days`; a quote from `GG.1503` §II.B is removed as wrong program; a `covered` item requiring 5 days with a quote saying thirty (30) days gets `number_mismatch` and becomes `needs_review`; verdict table rows.
3. **LLM client.** Test key works; saved-call cache returns a repeat call instantly; usage and cost recorded; warm-up rule implemented.
4. **Questionnaire pipeline, headless.** A dev button runs Q10, Q11, Q25 only and dumps JSON. Expected behaviour to verify by eye (these are the demo moments; if they do not hold, inspect before continuing):
   - Q10: evidence from `GG.1503` §II.C, page 2; nothing cited from §II.B; the "who certifies" item carries `wording_differs`.
   - Q11: flag `number_mismatch` (5 vs 30) or verdict `conflict`, citing §III.F.1.
   - Q25: the 12 services matched to the "Hospice Care" glossary entry; the in-network item not covered → `partial`.
   - No citation anywhere to a non-Medi-Cal policy.
5. **Questionnaire UI.** Start → progress with partial results → results → detail with PDF → approve → export filled form (open it in a PDF reader and confirm Q1, Q12 and Q64 landed in the right fields).
6. **Guide.** Section list, find obligations on "(Updated January 2026) Community Supports" (expect two Transitional Rent obligations), highlights, check → `not_found` with a closest policy.
7. **Toggles, estimates, differences view, demo export/replay.**
8. **Accuracy page.**

Expected cost of one full questionnaire run on defaults: about $1. A full run of the three demo Guide sections: about $0.50.

---

## 14. Decisions: what is deliberately not built

Do not add these. They were considered and cut.

| Not built | Reason |
|---|---|
| Any server or backend | Must run as a static site |
| Embeddings / vector search / rerankers | Haiku reads every policy, which already handles paraphrase |
| Policy summary cards, section cards | Reading every policy replaced choosing which to read |
| Merged glossary dictionary, synonym expansion | Full documents include their own glossaries |
| Trimmed reading copies, shared-definitions file | Saved about $0.10 per run and risked losing evidence |
| Following policy cross-references | Reading every policy covers them |
| Fetching APLs from the web, DHCS APL list checks | The APL is provided locally; its own "supersedes" line is enough |
| The API's built-in Citations feature | Quotes are returned as strings and verified by our own exact-match code, which is needed anyway |
| Batch API | Results are needed while the user waits |
| Agentic / tool-using search | Cannot guarantee coverage; unpredictable cost |
| Uploading arbitrary new questionnaires or guides in the browser | New documents go through `npm run prep`; the UI lists prepared ones |
| Missing-attachment detection, "found only in a non-Medi-Cal policy" label | No demo question depends on them |
| Learning from the user's edits | Only matters after real use |
| Cross-section gap report, suggested policy fixes, "policies affected by a new APL", editing or adding obligations, Guide export | Later product depth |
| Running the whole Guide at once | Section-by-section is the design |
| Logins, multiple plans, sharing | Out of scope |

---

## 15. Risks to watch during the build

- **Rate limits.** Step 9 sends about 3.6M input tokens in a few minutes. On a low API tier this will be throttled; the backoff handles it but the run takes longer. If it is too slow, lower `bundles` to 1 (about 250 calls) before changing anything else.
- **Glossary table parsing** is the most fragile prep step. The `GG.1503` "Hospice Care" check in §5.7 guards it.
- **Form field mapping** depends on widget geometry. The counts (64 and 64) and the manual check in phase 5 guard it; CSV export is the fallback.
- **PDF highlight** is best-effort by design. Opening the correct page is the requirement.
- **Thinking/effort request fields** differ by model generation. They live in one function in `llm/client.ts`.
- **API key in the browser** is visible to whoever uses that browser. This is acceptable only because each user supplies their own key. Never commit a key.
