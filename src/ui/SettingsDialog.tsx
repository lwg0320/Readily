import { useEffect, useRef, useState } from "react";
import { createLLM, memoryStore } from "../llm/client";
import { idbCallStore } from "../llm/cache";
import { useRunner } from "../store/runner";
import { useGuides } from "../store/guides";
import { useRuns } from "../store/runs";
import { useSettings } from "../store/settings";
import { Button } from "./bits";

export const PRIVACY = "Your policies stay in this browser. Text is sent only to the Anthropic API for analysis, using your own key.";

export function SettingsDialog() {
  const { apiKey, setApiKey, settingsOpen, openSettings } = useSettings();
  const running = useRunner((s) => !!s.active);
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(apiKey ?? "");
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "failed"; message?: string }>({ state: "idle" });
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (settingsOpen && !d.open) {
      setDraft(useSettings.getState().apiKey ?? "");
      setTest({ state: "idle" });
      setCleared(false);
      d.showModal();
    } else if (!settingsOpen && d.open) d.close();
  }, [settingsOpen]);

  const save = () => setApiKey(draft);
  const testKey = async () => {
    save();
    setTest({ state: "testing" });
    const llm = createLLM({ apiKey: () => draft.trim() || null, store: memoryStore(), browser: true });
    const r = await llm.testKey();
    setTest(r.ok ? { state: "ok" } : { state: "failed", message: r.kind === "auth" ? "The key was not accepted." : r.kind === "billing" ? "The key works, but the account has no credit." : r.kind === "no_key" ? "Paste a key first." : "The API could not be reached. Check your connection and try again." });
  };
  const clearSaved = async () => {
    if (!window.confirm("Delete every saved run, every Policy Guide review and every saved API result from this browser? Running them again will then cost the full price.")) return;
    await idbCallStore().clear();
    await useRuns.getState().clearAll();
    await useGuides.getState().clearAll();
    setCleared(true);
  };

  return (
    <dialog ref={ref} onClose={() => openSettings(false)} className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-md border border-rule bg-paper p-0 text-ink shadow-xl">
      <div className="border-b border-rule px-6 py-4">
        <h2 className="text-[18px] font-bold">Settings</h2>
      </div>
      <div className="space-y-6 px-6 py-5">
        <div>
          <label htmlFor="api-key" className="block font-semibold">
            Anthropic API key
          </label>
          <p className="mt-0.5 text-[13px] text-ink-soft">Needed to run a questionnaire. Saved answers can be read without it. The key is stored only in this browser.</p>
          <div className="mt-2 flex gap-2">
            <input
              id="api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setTest({ state: "idle" });
              }}
              onBlur={save}
              placeholder="sk-ant-…"
              className="min-w-0 flex-1 rounded border border-rule px-3 py-2 text-[14px]"
            />
            <Button onClick={testKey} disabled={!draft.trim() || test.state === "testing"}>
              {test.state === "testing" ? "Testing…" : "Test key"}
            </Button>
          </div>
          <p className="mt-2 min-h-5 text-[13px]" aria-live="polite">
            {test.state === "ok" && <span className="font-semibold text-covered">The key works.</span>}
            {test.state === "failed" && <span className="font-semibold text-conflict">{test.message}</span>}
          </p>
        </div>

        <div>
          <p className="font-semibold">Saved results</p>
          <p className="mt-0.5 text-[13px] text-ink-soft">Finished work is kept in this browser, so opening a run again or resuming one costs nothing.</p>
          <div className="mt-2 flex items-center gap-3">
            <Button onClick={clearSaved} disabled={running}>
              Clear saved results
            </Button>
            {cleared && <span className="text-[13px] text-ink-soft">Cleared.</span>}
            {running && <span className="text-[13px] text-ink-soft">Not available while a run is in progress.</span>}
          </div>
        </div>

        <p className="text-[13px] text-ink-soft">{PRIVACY}</p>
      </div>
      <div className="flex justify-end border-t border-rule px-6 py-3">
        <Button kind="primary" onClick={() => openSettings(false)}>
          Done
        </Button>
      </div>
    </dialog>
  );
}
