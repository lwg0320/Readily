import { useEffect } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { useCatalog } from "../store/catalog";
import { useRuns } from "../store/runs";
import { Home } from "./Home";
import { QuestionDetail } from "./QuestionDetail";
import { QuestionnaireStart } from "./QuestionnaireStart";
import { Results } from "./Results";
import { Page, Shell } from "./Shell";

export function App() {
  const { catalog, error, load } = useCatalog();
  const loadRuns = useRuns((s) => s.load);
  useEffect(() => {
    void load();
    void loadRuns();
  }, [load, loadRuns]);

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
            <Route path="/run/:runId" element={<Results />} />
            <Route path="/run/:runId/q/:n" element={<QuestionDetail />} />
            <Route path="*" element={<Home />} />
          </Routes>
        )}
      </Shell>
    </HashRouter>
  );
}
