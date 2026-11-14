# Readily Module

A local web app for a Medi-Cal compliance analyst. It does two jobs:

1. **Answers a DHCS Submission Review Form.** For each question it finds the exact passage in the plan's policies (P&Ps) that proves compliance, with quote, section and page.
2. **Reviews a DHCS Policy Guide section by section.** It pulls out every obligation in a section and checks each one against the P&Ps.

The full design is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Status

| Phase | What | State |
|---|---|---|
| 1 | Document preparation (`npm run prep`) | Done |
| 2 | Shared code and unit tests (`npm test`) | Done |
| 3 | API client (`npm run check:key`) | Done |
| 4 | Questionnaire pipeline | Not started |
| 5 | Questionnaire screens and form export | Not started |
| 6–8 | Policy Guide, accuracy toggles, replay, accuracy page | Not started |

## What is in the repo

- `scripts/prep/` — turns the source PDFs into the static data the app loads.
- `public/data/` — the generated data (committed):
  - `library.json` — counts and the list of policies
  - `policies/<ID>.json` — one file per policy: header fields, text, and a map from every character to its page, section address and program
  - `apl/APL25-008.json` — the All Plan Letter, page by page
  - `questionnaires/apl-25-008.json` — the 64 questions and the map of the form's fillable fields
  - `guides/ecm-2026-01.json` — the Policy Guide split into 141 sections
  - `search-index.json` — keyword search index over the Medi-Cal policies
- `public/pdfs/` — the PDFs the app shows (committed).
- `src/lib/` — text utilities, quote verification and search, shared by the prep script and the app.
- `src/pipeline/` — the plain-code steps: grouping, candidate selection, automatic checks, verdicts.
- `src/config/` — the model settings file and pipeline settings.
- `src/llm/` — the API client: retries, concurrency limit, saved-call store, prompt caching, cost tracking.
- `tests/` — unit tests, run against the real prepared data (`npm test`).

## Checking your API key

1. Create a file named `.env.local` in the repo root with one line: `ANTHROPIC_API_KEY=sk-ant-...`. The file is git-ignored. Never commit a key.
2. `npm install`
3. `npm run check:key`

This makes five small real calls (well under one cent) and checks the key, the request format, JSON output, the saved-call store and prompt caching. Every line should say PASS.

## Running the document preparation

You only need this if the source documents change. The generated data is already committed.

Prerequisites: Node 20+ and Poppler (`brew install poppler` on macOS).

1. Copy the `Readily` folder (with `Public Policies/`, `APL/`, `Regulatory Questionnaire.pdf`, `ECM Policy Guidelines.pdf`) to `source/Readily/`. This folder is git-ignored.
2. `npm install`
3. `npm run prep`

The script ends with a list of acceptance checks. Every line should say PASS.
