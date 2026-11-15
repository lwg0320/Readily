import { useEffect } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { useCatalog } from "../store/catalog";
import { loadDemos } from "../store/demo";
import { EvalPage } from "../eval/EvalPage";
import { useGuides } from "../store/guides";
import { useRuns } from "../store/runs";
import { Compare } from "./Compare";
import { GuidePage } from "./GuidePage";
import { Home } from "./Home";
import { QuestionDetail } from "./QuestionDetail";
import { QuestionnaireStart } from "./QuestionnaireStart";
import { Results } from "./Results";
import { Page, Shell } from "./Shell";

export function App() {
  const { catalog, error, load } = useCatalog();
  const loadRuns = useRuns((s) => s.load);
  const loadGuides = useGuides((s) => s.load);
  useEffect(() => {
    void load();
    // saved work in this browser first, then any demo files, which never replace it
    void Promise.all([loadRuns(), loadGuides()]).then(loadDemos);
  }, [load, loadRuns, loadGuides]);

  return (
    <HashRouter>
      <Shell>
        {error ? (
          <Page>
            <p className="font-semibold text-conflict">{error}</p>
          </Page>
        ) : !catalog ? (
          <Page>
            <p className="text-ink-soft">Opening the library…</p>
          </Page>
        ) : (
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/questionnaire/:id" element={<QuestionnaireStart />} />
            <Route path="/guide/:id" element={<GuidePage />} />
            <Route path="/guide/:id/:sectionId" element={<GuidePage />} />
            <Route path="/run/:runId" element={<Results />} />
            <Route path="/run/:runId/compare/:otherId" element={<Compare />} />
            <Route path="/run/:runId/q/:n" element={<QuestionDetail />} />
            <Route path="/dev/eval" element={<EvalPage />} />
            <Route path="*" element={<Home />} />
          </Routes>
        )}
      </Shell>
    </HashRouter>
  );
}
