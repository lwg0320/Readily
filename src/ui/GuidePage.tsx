// Reviewing a DHCS Policy Guide section by section (ARCHITECTURE.md §10.3, Steps 21–25).
// Left: the sections. Middle: the section's own words. Right: the obligations found in it and,
// once checked, whether the plan's policies state each one.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { TASKS } from "../config/models";
import { estimateSectionCheck, formatCost } from "../pipeline/estimate";
import type { Obligation } from "../pipeline/findObligations";
import { splitSentences, type Sentence } from "../pipeline/sentences";
import { formatCitation } from "../pipeline/verdicts";
import { loadGuide, pdfUrl, useCatalog } from "../store/catalog";
import { useGuides, type SectionWork } from "../store/guides";
import { useRunner, type ActiveRun } from "../store/runner";
import { useRuns, type Run } from "../store/runs";
import { useSettings } from "../store/settings";
import type { GuideSection, ItemResult, Verdict } from "../types";
import { Bar, Button, Icon, VerdictChip, VerdictInfo } from "./bits";
import { useLoaded } from "./hooks";
import { costText } from "./RunSummary";
import { Page } from "./Shell";

// one bookmark in the Guide lost its opening bracket: "Updated January 2026) Provider Contracting:"
const UPDATED = /\(?Updated\s+([A-Z][a-z]+\s+\d{4})\)\s*/;
const plainTitle = (title: string) => title.replace(UPDATED, "").replace(/:\s*$/, "") || title;
const updatedNote = (s: GuideSection) => (s.updated ? (s.title.match(UPDATED)?.[1] ?? s.text.slice(0, 400).match(UPDATED)?.[1] ?? "in this edition") : null);
export const itemVerdict = (status: ItemResult["status"]): Verdict => (status === "not_covered" ? "not_found" : status);

export function GuidePage() {
  const { id = "", sectionId } = useParams();
  const navigate = useNavigate();
  const catalog = useCatalog((s) => s.catalog);
  const meta = catalog?.guides.find((g) => g.id === id);
  const { value: guide, failed } = useLoaded(meta?.id, () => loadGuide(id));
  const work = useGuides((s) => s.work);
  const guidesLoaded = useGuides((s) => s.loaded);
  const runs = useRuns((s) => s.runs);
  const [updatedOnly, setUpdatedOnly] = useState(true);

  const sections = guide?.sections ?? [];
  const section = sections.find((s) => s.id === sectionId) ?? sections.find((s) => s.updated) ?? sections[0];
  // a section opened directly must be visible in the list even when it is not an Updated one
  useEffect(() => {
    if (section && !section.updated) setUpdatedOnly(false);
  }, [section]);

  if (!catalog) return null;
  if (!meta || failed)
    return (
      <Page>
        <p>This Policy Guide is not in the library.</p>
        <Link to="/" className="font-semibold text-stamp">
          Back to the start
        </Link>
      </Page>
    );
  if (!guide || !section || !guidesLoaded)
    return (
      <Page>
        <p className="text-ink-soft">Opening the Policy Guide…</p>
      </Page>
    );

  const stateOf = (s: GuideSection): "none" | "found" | "checked" => {
    const w = work[`${id}/${s.id}`];
    if (!w) return "none";
    return w.runId && runs[w.runId]?.status === "done" ? "checked" : "found";
  };
  const updated = sections.filter((s) => s.updated);
  const listed = updatedOnly ? updated : sections;

  return (
    <div className="flex h-full min-h-0">
      <nav className="flex w-[19rem] shrink-0 flex-col border-r border-rule bg-paper" aria-label="Sections of the Policy Guide">
        <div className="shrink-0 border-b border-rule px-4 py-3">
          <Link to="/" className="inline-flex items-center gap-1 text-[13px] font-semibold text-stamp">
            <Icon name="left" />
            Start
          </Link>
          <p className="mt-1.5 font-serif text-[16px] font-semibold leading-snug">{guide.title}</p>
          <p className="mt-0.5 text-[13px] text-ink-soft">
            {new Date(`${guide.date}T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}, {guide.pageCount} pages
          </p>
          <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[13.5px]">
            <input type="checkbox" checked={updatedOnly} onChange={(e) => setUpdatedOnly(e.target.checked)} className="h-4 w-4 accent-stamp" />
            Only the {updated.length} updated sections
          </label>
          <p className="mt-1.5 text-[13px] text-ink-soft tabular-nums">
            Updated sections checked: {updated.filter((s) => stateOf(s) === "checked").length} of {updated.length}
          </p>
        </div>
        <ol className="min-h-0 flex-1 overflow-auto py-1">
          {listed.map((s) => {
            const state = stateOf(s);
            const on = s.id === section.id;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/guide/${id}/${s.id}`)}
                  aria-current={on ? "true" : undefined}
                  className={`flex w-full items-start gap-2 py-1.5 pr-3 text-left text-[13.5px] leading-snug ${on ? "bg-stamp-wash font-semibold" : "hover:bg-desk"}`}
                  style={{ paddingLeft: `${0.75 + (updatedOnly ? 0 : Math.min(s.path.length, 3)) * 0.8}rem` }}
                >
                  <span
                    className={`mt-[0.35rem] h-2.5 w-2.5 shrink-0 rounded-full border ${state === "checked" ? "border-stamp bg-stamp" : state === "found" ? "border-stamp bg-stamp-wash" : "border-ink-faint"}`}
                    title={state === "checked" ? "Checked against your policies" : state === "found" ? "Obligations found, not checked yet" : "Not reviewed yet"}
                  />
                  <span className="min-w-0 flex-1">
                    {plainTitle(s.title)}
                    <span className="block text-[12px] font-normal text-ink-faint">
                      {updatedOnly && s.path.length > 0 && `${plainTitle(s.path[s.path.length - 1])}, `}
                      {s.pageStart === s.pageEnd ? `page ${s.pageStart}` : `pages ${s.pageStart} to ${s.pageEnd}`}
                      {s.updated && !updatedOnly && <span className="ml-1.5 rounded-sm bg-marker-soft px-1 font-semibold text-ink">Updated</span>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <SectionView key={section.id} guideId={id} section={section} work={work[`${id}/${section.id}`]} />
    </div>
  );
}

function SectionView({ guideId, section, work }: { guideId: string; section: GuideSection; work: SectionWork | undefined }) {
  const sentences = useMemo(() => splitSentences(section), [section]);
  const run = useRuns((s) => (work?.runId ? s.runs[work.runId] : undefined));
  const [picked, setPicked] = useState<string | null>(null);
  const textPane = useRef<HTMLDivElement>(null);

  const found = work?.found;
  const usedBy = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const o of found?.obligations ?? []) for (const sid of o.sentenceIds) m.set(sid, [...(m.get(sid) ?? []), o.id]);
    return m;
  }, [found]);
  const reasons = useMemo(() => new Map(found?.nonObligations.map((n) => [n.sentenceId, n.reason])), [found]);
  const unexplained = new Set(found?.unexplained);
  const pickedSentences = new Set(found?.obligations.find((o) => o.id === picked)?.sentenceIds);

  const pick = (o: Obligation) => {
    setPicked(o.id);
    textPane.current?.querySelector(`[data-sentence="${o.sentenceIds[0]}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const blocks: Sentence[][] = [];
  for (const s of sentences) (blocks[s.block] ??= []).push(s);
  const body = blocks.filter((b) => b.length && !b[0].footnote);
  const notes = blocks.filter((b) => b.length && b[0].footnote);
  const note = updatedNote(section);

  const mark = (s: Sentence) => {
    if (usedBy.has(s.id)) return { cls: `quote-mark ${pickedSentences.has(s.id) ? "outline outline-2 outline-offset-1 outline-stamp" : ""}`, title: undefined };
    if (unexplained.has(s.id)) return { cls: "underline decoration-review decoration-wavy decoration-2 underline-offset-4", title: "Sounds like a duty, but was not explained. Please read it." };
    if (found && s.cue) return { cls: "underline decoration-ink-faint decoration-dotted decoration-2 underline-offset-4", title: `Not an obligation: ${reasons.get(s.id) || "no reason given"}` };
    return { cls: "", title: undefined };
  };
  const paragraph = (b: Sentence[], key: number) => (
    <p key={key} className={b[0].bullet ? "relative pl-5" : ""}>
      {b[0].bullet && <span className="absolute left-0 text-ink-faint">»</span>}
      {b.map((s, i) => {
        const m = mark(s);
        const newPage = i > 0 ? s.page !== b[i - 1].page : false;
        return (
          <span key={s.id}>
            {newPage && <span className="mx-1 rounded-sm bg-desk px-1 font-sans text-[11.5px] text-ink-faint">page {s.page}</span>}
            <span data-sentence={s.id} className={m.cls} title={m.title}>
              {s.text}
            </span>{" "}
          </span>
        );
      })}
    </p>
  );

  return (
    <>
      <article ref={textPane} className="min-w-0 flex-1 overflow-auto bg-paper">
        <div className="mx-auto max-w-[44rem] px-8 py-7">
          {section.path.length > 0 && <p className="text-[13px] text-ink-soft">{section.path.map(plainTitle).join(" / ")}</p>}
          <h1 className="mt-1 font-serif text-[24px] font-semibold leading-tight">{plainTitle(section.title)}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] text-ink-soft">
            {note && <span className="rounded-sm bg-marker-soft px-1.5 py-0.5 font-semibold text-ink">Updated {note}</span>}
            <span>{section.pageStart === section.pageEnd ? `Page ${section.pageStart}` : `Pages ${section.pageStart} to ${section.pageEnd}`} of the Guide</span>
            <a href={`${pdfUrl("guides", guideId)}#page=${section.pageStart}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-stamp">
              <Icon name="external" />
              Open the PDF
            </a>
          </p>
          {found && (
            <p className="mt-3 border-l-2 border-rule pl-3 text-[13px] text-ink-soft">
              <span className="quote-mark text-ink">Highlighted</span> text is where an obligation was taken from.{" "}
              <span className="underline decoration-ink-faint decoration-dotted decoration-2 underline-offset-4">Dotted</span> text sounds like a duty but was judged not to be one; hover to see why.
            </p>
          )}
          <div className="mt-5 space-y-3.5 font-serif text-[16.5px] leading-[1.65]">{body.map(paragraph)}</div>
          {notes.length > 0 && <div className="mt-6 space-y-2 border-t border-rule-soft pt-4 font-serif text-[14px] leading-relaxed text-ink-soft">{notes.map(paragraph)}</div>}
        </div>
      </article>

      <aside className="flex w-[27rem] shrink-0 flex-col border-l border-rule bg-desk/40">
        <ObligationsPanel guideId={guideId} section={section} work={work} run={run} picked={picked} onPick={pick} />
      </aside>
    </>
  );
}

function ObligationsPanel({ guideId, section, work, run, picked, onPick }: { guideId: string; section: GuideSection; work: SectionWork | undefined; run: Run | undefined; picked: string | null; onPick: (o: Obligation) => void }) {
  const navigate = useNavigate();
  const catalog = useCatalog((s) => s.catalog)!;
  const { apiKey, openSettings } = useSettings();
  const { find, finding, problem, setTicked } = useGuides();
  const { active, startSection, cancel, problem: runProblem, dismissProblem } = useRunner();
  const key = `${guideId}/${section.id}`;
  const busyFinding = finding === key;
  const checking = active?.kind === "section" && active.sourceId === guideId && active.sectionId === section.id ? active : null;
  const myRunProblem = runProblem?.sourceId === guideId && runProblem.sectionId === section.id ? runProblem : null;

  if (!work) {
    return (
      <div className="px-5 py-6">
        <h2 className="text-[16px] font-bold">Obligations in this section</h2>
        <p className="mt-2 text-[14px] text-ink-soft">Readily reads this section and lists everything it requires or recommends that a plan or its providers do, each tied to the exact sentences it comes from.</p>
        {problem?.key === key && <p className="mt-3 rounded bg-conflict-wash px-3 py-2 text-[14px] font-semibold text-conflict">{problem.message}</p>}
        <div className="mt-4">
          {apiKey ? (
            <Button kind="primary" onClick={() => find(guideId, section)} disabled={!!finding}>
              {busyFinding ? "Reading the section…" : "Find obligations"}
            </Button>
          ) : (
            <Button kind="primary" onClick={() => openSettings(true)}>
              Add your API key to run live
            </Button>
          )}
          <p className="mt-2 text-[13px] text-ink-soft">{busyFinding ? "This takes a few seconds." : "Costs under one cent."}</p>
        </div>
      </div>
    );
  }

  const { obligations } = work.found;
  const ticked = obligations.filter((o) => !work.unticked.includes(o.id));
  const result = run?.results[0];
  const checkedIds = new Set(run?.section?.obligations.map((o) => o.id));
  const byId = new Map(result?.items.map((i) => [i.item.id, i]));
  const sameSet = !!run && ticked.length === checkedIds.size && ticked.every((o) => checkedIds.has(o.id));
  const estimate = estimateSectionCheck({ obligations: Math.max(1, ticked.length), mediCalPolicies: catalog.counts.mediCalPolicies, models: { fullReading: TASKS.fullReading.model, secondOpinion: TASKS.secondOpinion.model } });

  return (
    <>
      <div className="shrink-0 border-b border-rule px-5 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[16px] font-bold">
            {obligations.length === 0 ? "No obligations in this section" : `${obligations.length} ${obligations.length === 1 ? "obligation" : "obligations"} in this section`}
          </h2>
          {result && <VerdictInfo />}
        </div>
        {obligations.length === 0 && <p className="mt-1 text-[14px] text-ink-soft">Nothing here tells a plan or its providers to do something. Dotted text shows the sentences that were considered.</p>}
        {work.found.unexplained.length > 0 && (
          <p className="mt-1 text-[13.5px] text-review">
            {work.found.unexplained.length} {work.found.unexplained.length === 1 ? "sentence sounds" : "sentences sound"} like a duty but could not be explained. They have a wavy underline in the text: please read them.
          </p>
        )}
      </div>

      <ol className="min-h-0 flex-1 space-y-2.5 overflow-auto px-4 py-3">
        {obligations.map((o) => {
          const item = byId.get(o.id);
          const isTicked = !work.unticked.includes(o.id);
          return (
            <li key={o.id} className={`rounded-md border bg-paper ${picked === o.id ? "border-stamp" : "border-rule"}`}>
              <div className="flex gap-3 px-3.5 py-3">
                <input
                  type="checkbox"
                  checked={isTicked}
                  disabled={!!checking}
                  onChange={(e) => setTicked(guideId, section.id, o.id, e.target.checked)}
                  aria-label={`Include in the check: ${o.summary}`}
                  className="mt-1 h-4 w-4 shrink-0 accent-stamp"
                />
                <button type="button" onClick={() => onPick(o)} className="min-w-0 flex-1 text-left">
                  <span className="block text-[14.5px] leading-snug">{o.summary}</span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-ink-soft">
                    <span className={`rounded-sm px-1.5 py-0.5 font-semibold ${o.strength === "binding" ? "bg-ink text-white" : "border border-rule text-ink"}`}>{o.strength === "binding" ? "Must" : "Should"}</span>
                    <span>Guide page {o.page}</span>
                    <span>Show in the text</span>
                  </span>
                </button>
              </div>
              {item && (
                <div className="border-t border-rule-soft px-3.5 py-2.5">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <VerdictChip verdict={itemVerdict(item.status)} size="sm" />
                    <span className="text-[13px] text-ink-soft">
                      {item.evidence[0] && item.status !== "not_covered"
                        ? formatCitation(item.evidence[0]).replace(", p.", ", page ")
                        : item.trail?.closest
                          ? `Closest policy: ${formatCitation(item.trail.closest).replace(", p.", ", page ")}`
                          : item.evidence[0]
                            ? `Looked at ${formatCitation(item.evidence[0]).replace(", p.", ", page ")}`
                            : ""}
                    </span>
                  </div>
                  <button type="button" className="mt-1.5 text-[13px] font-semibold text-stamp" onClick={() => navigate(`/run/${run!.id}/q/${section.id}?item=${o.id}`)}>
                    See the evidence
                  </button>
                </div>
              )}
              {run && !item && !checking && run.status === "done" && <p className="border-t border-rule-soft px-3.5 py-2 text-[13px] text-ink-soft">Not part of the last check.</p>}
            </li>
          );
        })}
      </ol>

      <div className="shrink-0 border-t border-rule bg-paper px-5 py-3.5">
        {myRunProblem && (
          <div className="mb-3 rounded bg-conflict-wash px-3 py-2 text-[14px]" role="alert">
            <p className="font-semibold text-conflict">{myRunProblem.message}</p>
            <button type="button" className="mt-1 font-semibold text-stamp" onClick={myRunProblem.kind === "auth" || myRunProblem.kind === "no_key" || myRunProblem.kind === "billing" ? () => openSettings(true) : dismissProblem}>
              {myRunProblem.kind === "auth" || myRunProblem.kind === "no_key" || myRunProblem.kind === "billing" ? "Open Settings" : "Dismiss"}
            </button>
          </div>
        )}
        {checking ? (
          <CheckProgress active={checking} policies={catalog.counts.mediCalPolicies} onPause={cancel} />
        ) : (
          <>
            {run?.status === "done" && sameSet && (
              <p className="mb-2.5 text-[13.5px] text-ink-soft">
                Checked against all {run.policiesRead} Medi-Cal policies, {costText(run)}.
              </p>
            )}
            {run?.status === "paused" && <p className="mb-2.5 text-[13.5px] text-review">The check was paused. Finished work is saved.</p>}
            {obligations.length > 0 &&
              (!apiKey ? (
                <Button kind="primary" onClick={() => openSettings(true)}>
                  Add your API key to run live
                </Button>
              ) : run?.status === "paused" ? (
                <Button kind="primary" onClick={() => startSection(guideId, section.id, run.id)} disabled={!!active}>
                  Resume the check
                </Button>
              ) : run?.status === "done" && sameSet ? null : (
                <>
                  <Button kind="primary" onClick={() => startSection(guideId, section.id)} disabled={!!active || ticked.length === 0}>
                    Check {ticked.length} {ticked.length === 1 ? "obligation" : "obligations"} against your policies
                  </Button>
                  <p className="mt-2 text-[13px] text-ink-soft">
                    {active ? "Another run is in progress. This one can start when it finishes." : `About ${formatCost(estimate.cost)} and ${estimate.minutes} minutes: every one of the ${catalog.counts.mediCalPolicies} Medi-Cal policies is read against them.`}
                  </p>
                </>
              ))}
            <button type="button" className="mt-2.5 block text-[13px] font-semibold text-stamp disabled:opacity-50" disabled={!!finding || !!active || !apiKey} onClick={() => find(guideId, section, true)}>
              {busyFinding ? "Reading the section…" : "Find obligations again"}
            </button>
          </>
        )}
      </div>
    </>
  );
}

function CheckProgress({ active, policies, onPause }: { active: ActiveRun; policies: number; onPause: () => void }) {
  const stage = active.stage;
  return (
    <div aria-live="polite">
      <p className="text-[14px] font-semibold">
        {stage === "library"
          ? `Loading ${policies} Medi-Cal policies`
          : stage === "reading"
            ? "Reading the policies that matter in full, with a second opinion"
            : `Reading all ${policies} Medi-Cal policies against these obligations`}
      </p>
      <div className="mt-2">
        {stage === "library" ? <Bar done={active.library.done} total={active.library.total} /> : stage === "reading" ? <Bar done={active.readings} total={Math.max(active.readings + 1, 4)} /> : <Bar done={active.screening.done} total={active.screening.total || policies} />}
      </div>
      <p className="mt-1.5 text-[13px] text-ink-soft tabular-nums">
        {stage === "library" && `${active.library.done} of ${active.library.total || policies}`}
        {stage === "screening" && `${active.screening.done} of ${active.screening.total || policies} policies read`}
        {stage === "reading" && `${active.readings} readings finished so far. This last part takes a minute or two.`}
      </p>
      {active.slow && <p className="mt-2 rounded bg-review-wash px-3 py-1.5 text-[13px] text-review">The API is limiting our speed. Still working; nothing is lost.</p>}
      <Button className="mt-3" onClick={onPause}>
        Pause
      </Button>
    </div>
  );
}
