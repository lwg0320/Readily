// The accuracy page (ARCHITECTURE.md §12): scores a saved questionnaire run against hand labels
// and against a naive one-prompt baseline. A working tool for whoever builds or evaluates the
// product; Alex never needs it.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { MODELS } from "../config/models";
import { download } from "../export/csv";
import { idbCallStore } from "../llm/cache";
import { createLLM, LLMError, UsageTracker } from "../llm/client";
import { formatCost } from "../pipeline/estimate";
import { loadPolicy, loadQuestionnaire } from "../store/catalog";
import { useRuns } from "../store/runs";
import { useSettings } from "../store/settings";
import type { FoundBy, Verdict } from "../types";
import { Button, Icon, VerdictChip, when } from "../ui/bits";
import { useLoaded } from "../ui/hooks";
import { VERDICT_LABEL, VERDICT_ORDER } from "../ui/labels";
import { accuracyText } from "../ui/RunSummary";
import { Page } from "../ui/Shell";
import { BASELINE_POLICIES, runBaseline } from "./baseline";
import bundled from "./labels.json";
import { score, type BaselineAnswer, type Label, type Tally } from "./score";

const LABELS_KEY = "readily.labels";
const BASELINE_KEY = "readily.baseline";
const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: kept for this visit only */
  }
};
const LAYER: Record<FoundBy, string> = { "haiku-direct": "first pass, direct", "haiku-maybe": "first pass, maybe", exact: "exact search", keyword: "keyword search" };
const share = (t: Tally | null | undefined) => (!t ? "not recorded" : t.of === 0 ? "nothing to score" : `${t.right} of ${t.of}`);
const Mark = ({ ok }: { ok: boolean | null }) => (ok === null ? null : <Icon name={ok ? "check" : "cross"} className={ok ? "text-covered" : "text-conflict"} />);

export function EvalPage() {
  const runs = useRuns((s) => s.runs);
  const loaded = useRuns((s) => s.loaded);
  const apiKey = useSettings((s) => s.apiKey);
  const candidates = useMemo(
    () =>
      Object.values(runs)
        .filter((r) => r.kind === "questionnaire" && r.results.length > 0)
        .sort((a, b) => b.createdAt - a.createdAt),
    [runs],
  );
  const [runId, setRunId] = useState<string>("");
  const run = runs[runId] ?? candidates[0];
  const questionnaire = useLoaded(run?.sourceId, () => loadQuestionnaire(run!.sourceId)).value;

  const [labels, setLabels] = useState<Label[]>(() => read<Label[]>(LABELS_KEY, bundled as Label[]));
  const edited = useMemo(() => JSON.stringify(labels) !== JSON.stringify(bundled), [labels]);
  const setLabel = (question: number, patch: Partial<Label> | null) => {
    setLabels((all) => {
      const rest = all.filter((l) => l.question !== question);
      const current = all.find((l) => l.question === question);
      const next = patch === null ? rest : [...rest, { question, expectedVerdict: "covered" as Verdict, expectedPolicies: [], notes: "", ...current, ...patch }];
      next.sort((a, b) => a.question - b.question);
      write(LABELS_KEY, next);
      return next;
    });
  };

  const model = run?.models.fullReading ?? "haiku";
  const [baselines, setBaselines] = useState<Record<string, BaselineAnswer[]>>(() => read(BASELINE_KEY, {}));
  const baseline = baselines[model] ?? [];
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [onlyLabelled, setOnlyLabelled] = useState(true);
  useEffect(() => setMessage(null), [runId]);

  if (!loaded) return null;
  if (!run || !questionnaire)
    return (
      <Page>
        <h1 className="font-serif text-[26px] font-semibold">Accuracy</h1>
        <p className="mt-2 text-ink-soft">{run ? "Loading…" : "There is no questionnaire run to score yet. Run the questionnaire first, then come back."}</p>
        <Link to="/" className="mt-3 inline-block font-semibold text-stamp">
          Back to the start
        </Link>
      </Page>
    );

  const s = score(labels, run.results, run.foundBy, baseline);
  const byQuestion = new Map(s.rows.map((r) => [r.label.question, r]));
  const missing = labels.filter((l) => !baseline.some((b) => b.question === l.question));

  const startBaseline = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const tracker = new UsageTracker();
      const llm = createLLM({ apiKey: () => useSettings.getState().apiKey, store: idbCallStore(), browser: true });
      const policies = await Promise.all(BASELINE_POLICIES.map(loadPolicy));
      const wanted = new Set(labels.map((l) => l.question));
      const answers = await runBaseline({ questions: questionnaire.questions.filter((q) => wanted.has(q.number)), policies, model, llm, tracker });
      setBaselines((all) => {
        const next = { ...all, [model]: answers };
        write(BASELINE_KEY, next);
        return next;
      });
      setMessage(`Baseline answered ${answers.length} of ${wanted.size} labelled questions for ${formatCost(tracker.totalCost)}.`);
    } catch (err) {
      setMessage(err instanceof LLMError ? err.message : "The baseline could not be run.");
      if (!(err instanceof LLMError)) console.error(err);
    } finally {
      setBusy(false);
    }
  };

  const row = (name: string, help: string, ours: string, theirs: string) => (
    <tr className="border-t border-rule-soft align-top">
      <th scope="row" className="py-2.5 pr-4 text-left font-normal">
        <span className="font-semibold">{name}</span>
        <span className="block text-[13px] text-ink-soft">{help}</span>
      </th>
      <td className="py-2.5 pr-4 tabular-nums">{ours}</td>
      <td className="py-2.5 tabular-nums">{theirs}</td>
    </tr>
  );
  const layers = s.pipeline.layers;

  return (
    <Page wide>
      <Link to="/" className="inline-flex items-center gap-1 text-[14px] font-semibold text-stamp">
        <Icon name="left" />
        Start
      </Link>
      <h1 className="mt-3 font-serif text-[26px] font-semibold leading-tight">Accuracy against hand labels</h1>
      <p className="mt-1 max-w-[46rem] text-[14px] text-ink-soft">
        A label is what a person decided after reading the policies. This page scores a saved run against the labels, and against a naive baseline that hands the model {BASELINE_POLICIES.join(" and ")} with the question and asks for yes or no. The numbers mean little until there are enough labels: about 20, spread over all five verdicts.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[14px]">
        <label className="flex items-center gap-2">
          Run to score
          <select value={run.id} onChange={(e) => setRunId(e.target.value)} className="rounded border border-rule bg-paper px-2 py-1.5">
            {candidates.map((r) => (
              <option key={r.id} value={r.id}>
                {when(r.createdAt)}, {accuracyText(r)}, {r.results.length} answers{r.demo ? ", demo" : ""}
              </option>
            ))}
          </select>
        </label>
        <span className="text-ink-soft">
          {labels.length} labelled {labels.length === 1 ? "question" : "questions"}
        </span>
      </div>

      <table className="mt-4 w-full max-w-[58rem] text-[14px]">
        <thead>
          <tr className="text-left text-[13px] text-ink-soft">
            <th className="pb-1.5 font-normal">Measure</th>
            <th className="pb-1.5 pr-4 font-semibold text-ink">Readily, this run</th>
            <th className="pb-1.5 font-semibold text-ink">Naive baseline ({MODELS[model].short})</th>
          </tr>
        </thead>
        <tbody>
          {row("Yes or No is right", "“Covered” counts as Yes; every other verdict as No.", share(s.pipeline.answer), s.baseline ? share(s.baseline.answer) : "not run yet")}
          {row("Said Yes when the label says otherwise", "The dangerous mistake: an answer DHCS would reject.", String(s.pipeline.wrongYes), s.baseline ? String(s.baseline.wrongYes) : "not run yet")}
          {row("Exact verdict is right", "Covered, partly covered, conflict, not found or needs review.", share(s.pipeline.verdict), "gives only yes or no")}
          {row("Cites the expected policy", "Where the label names one.", share(s.pipeline.cited), s.baseline ? share(s.baseline.cited) : "not run yet")}
          {row(
            "Search pointed to the expected policy",
            layers ? `By layer: ${(Object.keys(layers) as FoundBy[]).map((l) => `${LAYER[l]} ${layers[l]}`).join(", ")}.` : "Recorded when a run finishes. Run the questionnaire again to record it; saved work makes that free.",
            share(s.pipeline.candidate),
            "was handed the policies",
          )}
          {row("Quotes are word for word in the policy", "Readily: all quotes in the run, before any correction. Baseline: its quotes that could be found at all.", share(s.pipeline.quotesExact), s.baseline ? share(s.baseline.quotesFound) : "not run yet")}
        </tbody>
      </table>

      <div className="mt-5 flex flex-wrap items-center gap-3 text-[14px]">
        {apiKey ? (
          <Button onClick={startBaseline} disabled={busy || labels.length === 0}>
            {busy ? "Running the baseline…" : baseline.length ? "Run the naive baseline again" : "Run the naive baseline"}
          </Button>
        ) : (
          <span className="text-ink-soft">Add an API key in Settings to run the baseline.</span>
        )}
        <span className="text-ink-soft">
          One call per labelled question, a few cents in all on Standard.{baseline.length > 0 && missing.length > 0 ? ` ${missing.length} labelled ${missing.length === 1 ? "question has" : "questions have"} no baseline answer yet.` : ""}
        </span>
        {message && <span className="font-semibold">{message}</span>}
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2">
        <h2 className="text-[17px] font-bold">Labels</h2>
        <label className="flex cursor-pointer items-center gap-2 text-[14px]">
          <input type="checkbox" checked={onlyLabelled} onChange={(e) => setOnlyLabelled(e.target.checked)} className="h-4 w-4 accent-stamp" />
          Only labelled questions
        </label>
        <div className="ml-auto flex items-center gap-2">
          {edited && <span className="text-[13px] text-review">Changed in this browser only.</span>}
          <Button onClick={() => download("labels.json", JSON.stringify(labels, null, 2) + "\n", "application/json")}>Download labels.json</Button>
          {edited && (
            <Button
              kind="quiet"
              onClick={() => {
                try {
                  localStorage.removeItem(LABELS_KEY);
                } catch {
                  /* nothing stored */
                }
                setLabels(bundled as Label[]);
              }}
            >
              Back to the file's labels
            </Button>
          )}
        </div>
      </div>
      <p className="mt-1 max-w-[46rem] text-[13px] text-ink-soft">
        To label a question, read the policies yourself, then choose what the right verdict is. Changes are kept in this browser; to keep them for good, download the file and save it as src/eval/labels.json.
      </p>

      <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[60rem] border-collapse rounded-md border border-rule bg-paper text-[13.5px]">
        <thead>
          <tr className="border-b border-rule text-left text-[13px] text-ink-soft">
            <th className="w-12 px-3 py-2 font-normal">No.</th>
            <th className="px-2 py-2 font-normal">Question</th>
            <th className="w-40 px-2 py-2 font-normal">Right verdict (label)</th>
            <th className="w-44 px-2 py-2 font-normal">Readily</th>
            <th className="w-52 px-2 py-2 font-normal">Expected policy</th>
            <th className="w-56 px-2 py-2 font-normal">Naive baseline</th>
          </tr>
        </thead>
        <tbody>
          {questionnaire.questions
            .filter((q) => !onlyLabelled || byQuestion.has(q.number))
            .map((q) => {
              const r = byQuestion.get(q.number);
              const label = r?.label;
              const result = run.results.find((x) => x.parentId === String(q.number));
              return (
                <tr key={q.number} className="border-t border-rule-soft align-top">
                  <td className="px-3 py-2.5 font-semibold tabular-nums">
                    {result ? (
                      <Link to={`/run/${run.id}/q/${q.number}`} className="text-stamp" title="Open this answer">
                        Q{q.number}
                      </Link>
                    ) : (
                      `Q${q.number}`
                    )}
                  </td>
                  <td className="px-2 py-2.5">
                    <span className="font-serif text-[14.5px] leading-snug">{q.text.length > 170 ? q.text.slice(0, q.text.lastIndexOf(" ", 170)) + "…" : q.text}</span>
                    {label && (
                      <textarea
                        key={`n-${q.number}-${label.notes}`}
                        defaultValue={label.notes}
                        onBlur={(e) => e.target.value !== label.notes && setLabel(q.number, { notes: e.target.value })}
                        placeholder="Why this is the right verdict (optional)"
                        aria-label={`Notes for question ${q.number}`}
                        rows={2}
                        className="mt-1.5 block w-full resize-y rounded border border-rule-soft px-2 py-1 text-[12.5px] leading-snug text-ink-soft [field-sizing:content]"
                      />
                    )}
                  </td>
                  <td className="px-2 py-2.5">
                    <select
                      value={label?.expectedVerdict ?? ""}
                      onChange={(e) => setLabel(q.number, e.target.value ? { expectedVerdict: e.target.value as Verdict } : null)}
                      aria-label={`Right verdict for question ${q.number}`}
                      className={`w-full rounded border border-rule bg-paper px-1.5 py-1 ${label ? "" : "text-ink-faint"}`}
                    >
                      <option value="">Not labelled</option>
                      {VERDICT_ORDER.map((v) => (
                        <option key={v} value={v}>
                          {VERDICT_LABEL[v]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2.5">
                    {result ? (
                      <span className="flex items-center gap-1.5">
                        <VerdictChip verdict={result.verdict} size="sm" />
                        <Mark ok={r?.verdictRight ?? null} />
                      </span>
                    ) : (
                      <span className="text-ink-faint">No answer in this run</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5">
                    {label && (
                      <>
                        <input
                          key={`p-${q.number}-${label.expectedPolicies.join()}`}
                          defaultValue={label.expectedPolicies.join(", ")}
                          onBlur={(e) => {
                            const ids = e.target.value.split(/[\s,;]+/).filter(Boolean);
                            if (ids.join() !== label.expectedPolicies.join()) setLabel(q.number, { expectedPolicies: ids });
                          }}
                          placeholder="e.g. GG.1503"
                          aria-label={`Expected policy for question ${q.number}`}
                          className="w-full rounded border border-rule-soft px-2 py-1"
                        />
                        {r && r.cited !== null && (
                          <span className="mt-1 flex items-center gap-1 text-[12.5px] text-ink-soft">
                            <Mark ok={r.cited} /> {r.cited ? "cited in the answer" : "not cited in the answer"}
                          </span>
                        )}
                        {r?.foundBy?.map((p) => (
                          <span key={p.policyId} className="block text-[12.5px] text-ink-soft">
                            {p.policyId}: {p.layers.length ? p.layers.map((l) => LAYER[l]).join("; ") : "no search layer pointed to it"}
                          </span>
                        ))}
                      </>
                    )}
                  </td>
                  <td className="px-2 py-2.5">
                    {r?.baseline && (
                      <>
                        <span className="flex items-center gap-1.5 font-semibold">
                          {r.baseline.answer === "yes" ? "Yes" : "No"} <Mark ok={r.baselineRight} />
                        </span>
                        <span className="block text-[12.5px] text-ink-soft">{r.baseline.citation}</span>
                        {r.baseline.quote && <span className={`block text-[12.5px] ${r.baseline.quoteFound ? "text-ink-soft" : "font-semibold text-conflict"}`}>{r.baseline.quoteFound ? "quote found in the policy" : "quote not found in the policy"}</span>}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
      </div>
    </Page>
  );
}
