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
| 4 | Questionnaire pipeline (`npm run try -- 10 11 25`, or `--all`) | Done; checked against the real API on all 64 questions (about $2.20 and 12 minutes on Haiku from scratch) |
| 5 | Questionnaire screens and form export (`npm run dev`) | Done; every screen driven in Chrome against a simulated API. Not yet run in a browser with a real key. |
| 6 | Policy Guide screen (`npm run try:section -- s015`) | Done; driven in Chrome against a simulated API. Not yet run with a real key. |
| 7–8 | Accuracy toggles, replay, accuracy page | Not started |

## Running the app

```
npm install
npm run dev
```

Open the address it prints (normally http://localhost:5173).

1. Click **Settings**, paste your Anthropic API key, and press **Test key**. The key is stored only in that browser.
2. Click **Answer this questionnaire**, then **Run all 64 questions**. A full run is about $2.30 and 10 minutes on the default settings. You can start reviewing as soon as the first answers arrive.
3. Open a question: the evidence is on the left, the policy page with the quote highlighted is on the right. Choose Yes or No, approve, and move on (keys: J, K, Y, N, A).
4. **Fill DHCS form** downloads the real form with your approved answers; **Download CSV** has everything.

To review the Policy Guide, click **Review this Guide** on the home page. Pick a section, press **Find obligations** (under a cent), then **Check obligations against your policies** (about $0.25 and four minutes per section, because every policy is read once against them). **See the evidence** opens the same evidence view as a questionnaire question.

Finished work is saved in the browser. A run that is paused, or interrupted by closing the tab, resumes without paying again. The browser's saved work is separate from what `npm run try` saves under `.cache/`, so the first run in the browser pays the full price even if you already ran the command line.

`npm run build` produces the static site in `dist/` (it works from any folder, including GitHub Pages).

## Trying one Policy Guide section from the command line

```
npm run try:section              # lists the 141 sections; updated ones are marked *
npm run try:section -- s015      # "Community Supports": finds its obligations, then checks them
npm run try:section -- s015 --find   # obligations only (under a cent)
```

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
- `src/store/` — what the screens share: the API key, the library, saved runs, and the controller that runs the pipeline in the browser.
- `src/ui/` — the screens: start, run progress, answers, and one question with its policy page.
- `src/export/` — the filled DHCS form and the CSV.
- `tests/` — unit tests, run against the real prepared data (`npm test`).

## Checking your API key

1. Create a file named `.env.local` in the repo root with one line: `ANTHROPIC_API_KEY=sk-ant-...`. The file is git-ignored. Never commit a key.
2. `npm install`
3. `npm run check:key`

This makes five small real calls (well under one cent) and checks the key, the request format, JSON output, the saved-call store and prompt caching. Every line should say PASS.

## Trying the pipeline on a few questions

With `.env.local` in place:

```
npm run try -- 10 11 25
```

This runs the real pipeline on those questions: it turns them into checks, reads all 251 Medi-Cal policies, reads the candidates in full, gets a second opinion and prints each verdict with its quotes, flags and cost. Expect two to four minutes and about $0.30–0.50. Finished calls are saved under `.cache/`, so running the same questions again is instant and free.

Options: `--all` (whole questionnaire, about $1.30), `--reading=opus`, `--review=opus`, `--fresh` (ignore saved calls).

## Running the document preparation

You only need this if the source documents change. The generated data is already committed.

Prerequisites: Node 20.19 or newer (22+ recommended) and Poppler (`brew install poppler` on macOS).

1. Copy the `Readily` folder (with `Public Policies/`, `APL/`, `Regulatory Questionnaire.pdf`, `ECM Policy Guidelines.pdf`) to `source/Readily/`. This folder is git-ignored.
2. `npm install`
3. `npm run prep`

The script ends with a list of acceptance checks. Every line should say PASS.
