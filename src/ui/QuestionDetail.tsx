// One question, or one Policy Guide section: the evidence on the left, the policy page on the
// right (ARCHITECTURE.md §10.3, Step 17). A section is shown the same way as a question, with
// its obligations as the parts; it has no form answer to approve.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { formatCitation, sortByRisk } from "../pipeline/verdicts";
import { loadApl, loadQuestionnaire, pdfUrl, useCatalog } from "../store/catalog";
import { currentAnswer, useRuns } from "../store/runs";
import type { Obligation } from "../pipeline/findObligations";
import type { Evidence, FlagCode, ItemResult } from "../types";
import { Button, Icon, StatusMark, VerdictChip, VerdictInfo } from "./bits";
import { useLoaded } from "./hooks";
import { FLAG_LABEL, VERDICT_HELP } from "./labels";
import { PdfPane, type PdfTarget } from "./PdfPane";
import { Page } from "./Shell";

const FRESHNESS: FlagCode[] = ["policy_predates_apl", "cites_superseded_apl"];
/** Flags that are already told by the second-opinion lines or the wording note. */
const TOLD_ELSEWHERE: FlagCode[] = [...FRESHNESS, "reviewer_disputed", "reviewer_found_evidence", "conflict_unconfirmed", "wording_differs"];
const ANSWER_WORD = { covered: "Stated in policy", not_covered: "Not stated", conflict: "Conflicts with policy" } as const;

export function QuestionDetail() {
  const { runId = "", n = "" } = useParams();
  const navigate = useNavigate();
  const run = useRuns((s) => s.runs[runId]);
  const loaded = useRuns((s) => s.loaded);
  const patch = useRuns((s) => s.patchResult);
  const catalog = useCatalog((s) => s.catalog);
  const isSection = run?.kind === "section";
  const [params] = useSearchParams();
  const focusItem = params.get("item");
  const questionnaire = useLoaded(run && !isSection ? run.sourceId : undefined, () => loadQuestionnaire(run!.sourceId)).value;
  const apl = useLoaded(questionnaire?.aplId, () => loadApl(questionnaire!.aplId)).value;

  const ordered = useMemo(() => (run ? sortByRisk(run.results) : []), [run]);
  const index = ordered.findIndex((r) => r.parentId === n);
  const result = index >= 0 ? ordered[index] : undefined;
  const question = questionnaire?.questions.find((q) => String(q.number) === n);

  const [picked, setPicked] = useState<PdfTarget | null>(null);
  const [citationDraft, setCitationDraft] = useState<string | null>(null);
  const [justApproved, setJustApproved] = useState(false);
  useEffect(() => {
    setPicked(null);
    setCitationDraft(null);
    setJustApproved(false);
  }, [n, runId]);

  const titles = useMemo(() => new Map(catalog?.policies.map((p) => [p.id, p.title])), [catalog]);
  const policyTarget = (e: Pick<Evidence, "policyId" | "page"> & { quote?: string }): PdfTarget => ({
    url: pdfUrl("policies", e.policyId),
    label: `${e.policyId} ${titles.get(e.policyId) ?? ""}`.trim(),
    page: e.page,
    quote: e.quote,
  });
  const aplTarget = (page: number): PdfTarget | null => (apl ? { url: pdfUrl("apl", apl.id), label: `APL ${apl.number} (what DHCS requires)`, page } : null);
  const guideTarget = (page: number, quote?: string): PdfTarget => ({ url: pdfUrl("guides", run!.sourceId), label: `${run!.title} (what DHCS requires)`, page, quote });
  const obligations = useMemo(() => new Map(run?.section?.obligations.map((o) => [o.id, o])), [run]);

  // Opened from one obligation on the Guide page: bring that obligation into view.
  useEffect(() => {
    if (focusItem && result) document.getElementById(`check-${focusItem}`)?.scrollIntoView({ block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusItem, !!result]);

  const go = (id: string | undefined) => (id ? navigate(`/run/${runId}/q/${id}`) : navigate(`/run/${runId}`));
  const previous = index > 0 ? ordered[index - 1].parentId : undefined;
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1].parentId : undefined;
  const nextUnapproved = () => {
    for (let k = 1; k < ordered.length; k++) {
      const r = ordered[(index + k) % ordered.length];
      if (!r.approved) return r.parentId;
    }
    return undefined;
  };

  const answer = result ? currentAnswer(result) : null;
  const citation = citationDraft ?? answer?.citation ?? "";
  const setAnswer = (a: "yes" | "no") => result && !result.approved && patch(runId, n, { edited: { answer: a, citation } });
  const saveCitation = () => {
    if (result && citationDraft !== null && citationDraft !== answer?.citation) patch(runId, n, { edited: { answer: answer?.answer ?? null, citation: citationDraft } });
  };
  const approve = () => {
    if (!result || result.approved || !answer?.answer) return;
    saveCitation();
    patch(runId, n, { approved: true });
    setJustApproved(true);
    const target = nextUnapproved();
    // a short beat so the stamp is seen before the next question appears
    window.setTimeout(() => go(target), 420);
  };

  useEffect(() => {
    if (isSection) return; // nothing to answer or approve on a Guide section
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) || document.querySelector("dialog[open]")) return;
      const k = e.key.toLowerCase();
      if (k === "j" && next) go(next);
      else if (k === "k" && previous) go(previous);
      else if (k === "y") setAnswer("yes");
      else if (k === "n") setAnswer("no");
      else if (k === "a") approve();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!loaded || !catalog) return null;
  if (!run || !result)
    return (
      <Page>
        <p>{run ? "This question has no answer yet." : "This run is not saved in this browser."}</p>
        <Link to={run ? `/run/${runId}` : "/"} className="font-semibold text-stamp">
          {run ? "Back to all answers" : "Back to the start"}
        </Link>
      </Page>
    );

  // what to show on the right before anything is clicked: the obligation she came for, if any
  const first = [...result.items].sort((a, b) => Number(b.item.id === focusItem) - Number(a.item.id === focusItem));
  const firstEvidence = first.find((i) => i.status !== "not_covered" && i.evidence.length)?.evidence[0] ?? first.find((i) => i.evidence.length)?.evidence[0];
  const closest = first.find((i) => i.trail?.closest)?.trail?.closest;
  const focused = focusItem ? first[0] : undefined;
  const focusedTarget = focused?.item.id === focusItem ? (focused.evidence[0] ? policyTarget(focused.evidence[0]) : focused.trail?.closest ? policyTarget(focused.trail.closest) : null) : null;
  const target =
    picked ??
    focusedTarget ??
    (firstEvidence ? policyTarget(firstEvidence) : closest ? policyTarget(closest) : isSection ? guideTarget(run.section?.pageStart ?? 1) : question ? aplTarget(question.aplPages[0] ?? 1) : null);
  const isPicked = (e: Evidence) => !!target && target.url === pdfUrl("policies", e.policyId) && target.page === e.page && target.quote === e.quote;

  // only for policies an answer rests on, not for text that was looked at and set aside
  const freshness = [...new Set(result.items.filter((i) => i.status !== "not_covered").flatMap((i) => i.flags.filter((f) => FRESHNESS.includes(f.code)).map((f) => f.detail)))];
  const approvedCount = run.results.filter((r) => r.approved).length;
  const missing = result.items.filter((i) => i.status === "not_covered").length;
  const advice =
    result.verdict === "partial"
      ? `${missing} of ${result.items.length} parts ${missing === 1 ? "is" : "are"} not stated. If DHCS needs every part, the answer is No.`
      : VERDICT_HELP[result.verdict];

  return (
    <div className="flex h-full min-h-0">
      <section className="flex w-[47%] min-w-[27rem] max-w-[48rem] flex-col border-r border-rule bg-paper">
        <div className="flex shrink-0 items-center gap-3 border-b border-rule px-5 py-2.5 text-[13px]">
          {isSection ? (
            <Link to={`/guide/${run.sourceId}/${n}`} className="inline-flex items-center gap-1 font-semibold text-stamp">
              <Icon name="left" />
              Back to the Guide section
            </Link>
          ) : (
            <>
              <Link to={`/run/${runId}`} className="inline-flex items-center gap-1 font-semibold text-stamp">
                <Icon name="left" />
                All answers
              </Link>
              <span className="text-ink-soft">
                {index + 1} of {ordered.length}, riskiest first
              </span>
              <span className="ml-auto text-ink-soft tabular-nums">
                {approvedCount} of {run.questionCount} approved
              </span>
              <div className="flex gap-1">
                <Button className="!px-2 !py-1" onClick={() => go(previous)} disabled={!previous} aria-label="Previous question">
                  <Icon name="left" />
                </Button>
                <Button className="!px-2 !py-1" onClick={() => go(next)} disabled={!next} aria-label="Next question">
                  <Icon name="right" />
                </Button>
              </div>
            </>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <div className="flex items-center gap-3">
            <h1 className="text-[20px] font-bold">{isSection ? "Policy Guide section" : `Question ${n}`}</h1>
            <div className="flex items-center gap-1">
              <VerdictChip verdict={result.verdict} />
              <VerdictInfo />
            </div>
          </div>
          <p className="mt-2.5 font-serif text-[16.5px] leading-[1.5]">{isSection ? run.section?.title : (question?.text ?? "")}</p>
          {isSection && run.section && (
            <p className="mt-1 text-[13px] text-ink-soft">
              {run.section.path.join(" / ")}.{" "}
              <button type="button" className="font-semibold text-stamp" onClick={() => setPicked(guideTarget(run.section!.pageStart))}>
                Show page {run.section.pageStart} of the Guide
              </button>
            </p>
          )}

          {question && apl && (
            <details className="mt-3 text-[14px]">
              <summary className="cursor-pointer font-semibold text-stamp">
                What DHCS requires: APL {apl.number}, page {question.aplPages.join(" and ")}
              </summary>
              <div className="mt-2 border-l-2 border-rule pl-4">
                {apl.pages
                  .filter((p) => question.aplPages.includes(p.page))
                  .map((p) => (
                    <div key={p.page} className="mb-3">
                      <button type="button" className="text-[13px] font-semibold text-stamp" onClick={() => setPicked(aplTarget(p.page))}>
                        Show page {p.page} of the APL
                      </button>
                      <p className="mt-1 whitespace-pre-wrap font-serif text-[14.5px] leading-relaxed text-ink-soft">{p.text.trim()}</p>
                    </div>
                  ))}
              </div>
            </details>
          )}

          {freshness.length > 0 && (
            <div className="mt-4 flex gap-2 rounded bg-review-wash px-3 py-2 text-[13.5px] text-review">
              <Icon name="clock" className="mt-0.5" />
              <div>
                <p className="font-semibold">A cited policy may be out of date</p>
                {freshness.map((f) => (
                  <p key={f}>{f}.</p>
                ))}
              </div>
            </div>
          )}

          <h2 className="mt-6 text-[15px] font-bold">
            {isSection
              ? result.items.length === 1
                ? "The obligation that was checked"
                : `The ${result.items.length} obligations that were checked`
              : result.items.length === 1
                ? "What DHCS is asking for"
                : `The ${result.items.length} things DHCS is asking for`}
          </h2>
          <ol className="mt-2 divide-y divide-rule-soft border-y border-rule-soft">
            {result.items.map((item) => (
              <Check
                key={item.item.id}
                item={item}
                titles={titles}
                isPicked={isPicked}
                onPick={(t) => setPicked(policyTarget(t))}
                source={obligations.get(item.item.id)}
                onShowSource={(o) => setPicked(guideTarget(o.page, o.sourceText.split(/(?<=[.;])\s+/)[0]))}
              />
            ))}
          </ol>
        </div>

        {!isSection && (
        <div className="shrink-0 border-t border-rule bg-desk/50 px-5 py-3">
          <p className="text-[13.5px] text-ink-soft">{advice}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <div className="flex overflow-hidden rounded border border-rule" role="group" aria-label="Answer for the DHCS form">
              {(["yes", "no"] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  aria-pressed={answer?.answer === a}
                  disabled={result.approved}
                  onClick={() => setAnswer(a)}
                  className={`px-4 py-2 text-[14px] font-semibold disabled:cursor-not-allowed ${answer?.answer === a ? "bg-ink text-white" : "bg-paper text-ink hover:bg-desk disabled:opacity-50"}`}
                >
                  {a === "yes" ? "Yes" : "No"}
                </button>
              ))}
            </div>
            <label className="flex min-w-[14rem] flex-1 items-center gap-2 text-[13px] text-ink-soft">
              Citation
              <input
                value={citation}
                disabled={result.approved}
                onChange={(e) => setCitationDraft(e.target.value)}
                onBlur={saveCitation}
                placeholder={answer?.answer === "no" ? "Leave empty, or cite the closest section" : "Policy, section and page"}
                className="min-w-0 flex-1 rounded border border-rule bg-paper px-2.5 py-2 text-[14px] text-ink disabled:bg-desk"
              />
            </label>
          </div>
          {citation.length > 90 && <p className="mt-1.5 text-[12.5px] text-review">The form's citation box holds about 90 characters. The full list is always in the CSV.</p>}

          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
            {result.approved ? (
              <>
                <span className={`stamp text-[13px] ${justApproved ? "pressed" : ""}`}>Approved</span>
                <Button onClick={() => patch(runId, n, { approved: false })}>Reopen</Button>
              </>
            ) : (
              <Button kind="primary" onClick={approve} disabled={!answer?.answer} title={answer?.answer ? undefined : "Choose Yes or No first"}>
                Approve and go to the next
              </Button>
            )}
            <Button kind="quiet" onClick={() => patch(runId, n, { followUp: result.followUp === undefined ? "" : undefined })} aria-pressed={result.followUp !== undefined}>
              <Icon name="flag" />
              {result.followUp === undefined ? "Flag for follow-up" : "Remove follow-up flag"}
            </Button>
            {result.edited && !result.approved && (
              <Button
                kind="quiet"
                onClick={() => {
                  setCitationDraft(null);
                  patch(runId, n, { edited: undefined });
                }}
              >
                Reset to the suggestion
              </Button>
            )}
            <span className="ml-auto text-[12px] text-ink-faint">Keys: J and K move, Y and N answer, A approves</span>
          </div>
          {result.followUp !== undefined && (
            <input
              key={`${runId}-${n}`}
              defaultValue={result.followUp}
              onBlur={(e) => patch(runId, n, { followUp: e.target.value.trim() })}
              placeholder="Note for the follow-up (optional)"
              aria-label="Follow-up note"
              className="mt-2.5 w-full rounded border border-rule bg-paper px-2.5 py-2 text-[14px]"
            />
          )}
        </div>
        )}
      </section>

      <section className="min-w-0 flex-1">{target ? <PdfPane target={target} /> : <div className="flex h-full items-center justify-center text-ink-soft">No document to show for this question.</div>}</section>
    </div>
  );
}

type CheckProps = {
  item: ItemResult;
  titles: Map<string, string>;
  isPicked: (e: Evidence) => boolean;
  onPick: (t: { policyId: string; page: number; quote?: string }) => void;
  /** For a Guide obligation: where in the Guide it comes from. */
  source?: Obligation;
  onShowSource?: (o: Obligation) => void;
};

function Check({ item, titles, isPicked, onPick, source, onShowSource }: CheckProps) {
  const disputed = item.status === "not_covered";
  const codes = new Set(item.flags.map((f) => f.code));
  const notes = item.flags.filter((f) => !TOLD_ELSEWHERE.includes(f.code));
  const trail = item.trail;
  return (
    <li className="scroll-mt-2 py-4" id={`check-${item.item.id}`}>
      <StatusMark status={item.status} />
      <p className="mt-1 text-[15px] leading-snug">{item.item.requirement}</p>
      {source && (
        <p className="mt-1.5 border-l-2 border-rule pl-3 text-[13.5px] text-ink-soft">
          <span className="font-serif text-[14.5px]">“{source.sourceText}”</span>{" "}
          <button type="button" className="font-semibold text-stamp" onClick={() => onShowSource?.(source)}>
            Guide page {source.page}
          </button>
        </p>
      )}

      {item.evidence.length > 0 && (
        <div className="mt-2.5 space-y-2">
          {disputed && <p className="text-[13px] font-semibold text-ink-soft">Looked at, but judged not to state this:</p>}
          {item.evidence.map((e, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onPick(e)}
              aria-pressed={isPicked(e)}
              className={`block w-full rounded border px-3 py-2.5 text-left ${isPicked(e) ? "border-stamp bg-stamp-wash/40" : "border-rule hover:border-ink-faint"}`}
            >
              <span className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                <span className="font-bold">{formatCitation(e).replace(", p.", ", page ")}</span>
                <span className="text-ink-soft">{titles.get(e.policyId)}</span>
              </span>
              <span className="mt-1.5 block font-serif text-[15.5px] leading-[1.6]">
                <span className={`quote-mark ${disputed ? "disputed" : ""}`}>{e.quote}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {notes.map((f, i) => (
        <p key={i} className={`mt-2 flex gap-2 text-[13.5px] ${f.code === "number_mismatch" || f.code === "analysis_failed" || f.code === "policies_disagree" ? "font-semibold text-conflict" : "text-review"}`}>
          <Icon name="alert" className="mt-0.5" />
          <span>
            <span className="capitalize-first">{FLAG_LABEL[f.code][0].toUpperCase() + FLAG_LABEL[f.code].slice(1)}</span>
            {f.detail ? `: ${f.detail}` : ""}
          </span>
        </p>
      ))}

      <dl className="mt-2.5 space-y-1 text-[13.5px] text-ink-soft">
        {item.readerReason && (
          <div>
            <dt className="inline font-semibold text-ink">First reading{codes.has("wording_differs") ? " (wording differs)" : ""}: </dt>
            <dd className="inline">{item.readerReason}</dd>
          </div>
        )}
        {item.reviewer && (
          <div>
            <dt className={`inline font-semibold ${item.reviewer.agrees ? "text-ink" : "text-review"}`}>{item.reviewer.agrees ? "Second opinion agrees: " : "Second opinion disagreed: "}</dt>
            <dd className="inline">{item.reviewer.reason}</dd>
          </div>
        )}
        {item.tieBreak && (
          <div>
            <dt className="inline font-semibold text-ink">Third reading says “{ANSWER_WORD[item.tieBreak.status].toLowerCase()}”: </dt>
            <dd className="inline">{item.tieBreak.reason}</dd>
          </div>
        )}
      </dl>

      {trail && (
        <div className="mt-2.5 flex gap-2 rounded bg-desk px-3 py-2 text-[13.5px] text-ink-soft">
          <Icon name="search" className="mt-0.5" />
          <div>
            <p>Read all {trail.policiesRead} Medi-Cal policies and found nothing that states this.</p>
            {trail.exactTerms.map((t) => (
              <p key={t.term}>
                “{t.term}” appears in {t.hits === 0 ? "no policy" : t.hits === 1 ? "1 policy" : `${t.hits} policies`}.
              </p>
            ))}
            {trail.skippedCandidates.length > 0 && <p>{trail.skippedCandidates.length} loosely related {trail.skippedCandidates.length === 1 ? "policy was" : "policies were"} screened but not read in full.</p>}
            {trail.closest && (
              <p>
                Closest passage:{" "}
                <button type="button" className="font-semibold text-stamp" onClick={() => onPick(trail.closest!)}>
                  {formatCitation(trail.closest).replace(", p.", ", page ")}
                </button>
              </p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
