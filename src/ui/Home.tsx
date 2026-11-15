import { Link, useNavigate } from "react-router-dom";
import { useCatalog } from "../store/catalog";
import { useGuides } from "../store/guides";
import { useRunner } from "../store/runner";
import { useRuns, type Run } from "../store/runs";
import { useSettings } from "../store/settings";
import { Button, Icon, when } from "./bits";
import { accuracyText, costText, VerdictCounts } from "./RunSummary";
import { Page } from "./Shell";

export function Home() {
  const catalog = useCatalog((s) => s.catalog);
  const runs = useRuns((s) => s.runs);
  if (!catalog) return null;
  // Guide section checks are reached from the Guide itself, where each section shows its state
  const recent = Object.values(runs)
    .filter((r) => r.kind === "questionnaire")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const guideWork = useGuides((s) => s.work);

  return (
    <Page>
      <h1 className="font-serif text-[30px] font-semibold leading-tight">Answer DHCS from your own policies</h1>
      <p className="mt-3 max-w-[40rem] text-[16px] text-ink-soft">
        Readily reads every Medi-Cal policy in the library against each DHCS question, or each obligation in a Policy Guide. It quotes the exact text that answers it and shows you where nothing does. You approve each answer before it reaches a form.
      </p>

      <p className="mt-6 flex items-center gap-2 text-[14px] text-ink-soft">
        <Icon name="check" className="text-covered" />
        Library ready: {catalog.counts.policies} policies, {catalog.counts.mediCalPolicies} of them Medi-Cal, {catalog.counts.pages.toLocaleString()} pages.
      </p>

      <section className="mt-8">
        <h2 className="text-[17px] font-bold">Questionnaires</h2>
        <ul className="mt-3 divide-y divide-rule-soft rounded-md border border-rule bg-paper">
          {catalog.questionnaires.map((q) => (
            <li key={q.id} className="flex items-center gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="font-serif text-[18px] font-semibold leading-snug">
                  APL {q.aplNumber}: {q.subject}
                </p>
                <p className="mt-0.5 text-[14px] text-ink-soft">DHCS Submission Review Form, {q.questionCount} questions. The APL itself is in the library.</p>
              </div>
              <Link to={`/questionnaire/${q.id}`} className="shrink-0 rounded bg-stamp px-4 py-2 text-[14px] font-semibold text-white hover:bg-stamp-dark">
                Answer this questionnaire
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="text-[17px] font-bold">Policy Guides</h2>
        <ul className="mt-3 divide-y divide-rule-soft rounded-md border border-rule bg-paper">
          {catalog.guides.map((g) => {
            const started = Object.values(guideWork).filter((w) => w.guideId === g.id).length;
            return (
              <li key={g.id} className="flex items-center gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="font-serif text-[18px] font-semibold leading-snug">{g.title}</p>
                  <p className="mt-0.5 text-[14px] text-ink-soft">
                    {new Date(`${g.date}T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}, {g.pageCount} pages. {g.updatedSections} of its {g.sectionCount} sections were updated in this edition
                    {started > 0 ? `; you have started on ${started}.` : "."}
                  </p>
                </div>
                <Link to={`/guide/${g.id}`} className="shrink-0 rounded bg-stamp px-4 py-2 text-[14px] font-semibold text-white hover:bg-stamp-dark">
                  Review this Guide
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-[17px] font-bold">Your questionnaire runs</h2>
        {recent.length === 0 ? (
          <p className="mt-2 text-[14px] text-ink-soft">Nothing yet. Answers you produce are kept in this browser and listed here.</p>
        ) : (
          <ul className="mt-3 divide-y divide-rule-soft rounded-md border border-rule bg-paper">
            {recent.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        )}
      </section>
    </Page>
  );
}

function RunRow({ run }: { run: Run }) {
  const navigate = useNavigate();
  const { active, start } = useRunner();
  const hasKey = useSettings((s) => !!s.apiKey);
  const isActive = active?.runId === run.id;
  const ready = run.results.length;
  const approved = run.results.filter((r) => r.approved).length;

  return (
    <li className="flex items-center gap-4 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          {run.title}
          {run.demo && <span className="ml-2 rounded-sm bg-marker-soft px-1.5 py-0.5 text-[12px]">Demo run</span>}
        </p>
        <p className="mt-0.5 text-[13px] text-ink-soft">
          {when(run.createdAt)}, {accuracyText(run)}, {costText(run)}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {run.status === "done" ? (
            <span className="text-[13px] text-ink-soft">
              {approved} of {run.questionCount} approved
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-review">
              <Icon name="clock" />
              {isActive ? "Running" : "Paused"}, {ready} of {run.questionCount} answers ready
            </span>
          )}
          <VerdictCounts run={run} />
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {run.status === "paused" && !active && hasKey && (
          <Button
            onClick={() => {
              start(run.sourceId, run.id);
              navigate(`/questionnaire/${run.sourceId}`);
            }}
          >
            Resume
          </Button>
        )}
        {isActive && <Button onClick={() => navigate(`/questionnaire/${run.sourceId}`)}>See progress</Button>}
        {ready > 0 && (
          <Button kind="primary" onClick={() => navigate(`/run/${run.id}`)}>
            {run.status === "done" ? "Open answers" : "Open answers so far"}
          </Button>
        )}
      </div>
    </li>
  );
}
