import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useCatalog } from "../store/catalog";
import { useRunner } from "../store/runner";
import { useSettings } from "../store/settings";
import { AccuracyControl } from "./AccuracyControl";
import { Button, Icon } from "./bits";
import { PRIVACY, SettingsDialog } from "./SettingsDialog";

export function Shell({ children }: { children: ReactNode }) {
  const planName = useCatalog((s) => s.catalog?.planName);
  const { apiKey, openSettings } = useSettings();
  const active = useRunner((s) => s.active);
  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-rule bg-paper">
        <div className="flex h-12 items-center gap-4 px-5">
          <Link to="/" className="text-[18px] font-extrabold tracking-tight text-ink">
            Readily
          </Link>
          {planName && <span className="border-l border-rule pl-4 text-[14px] text-ink-soft">{planName}</span>}
          <div className="ml-auto flex items-center gap-3">
            {active && (
              <Link to={active.kind === "section" ? `/guide/${active.sourceId}/${active.sectionId}` : `/questionnaire/${active.sourceId}`} className="flex items-center gap-2 text-[13px] font-semibold text-stamp">
                <span className="h-2 w-2 animate-pulse rounded-full bg-stamp motion-reduce:animate-none" />
                Run in progress
              </Link>
            )}
            <AccuracyControl />
            {!apiKey && <span className="text-[13px] text-ink-soft">No API key yet</span>}
            <Button kind="quiet" onClick={() => openSettings(true)} className="!px-2.5 !py-1.5">
              <Icon name="gear" />
              Settings
            </Button>
          </div>
        </div>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
      <footer className="shrink-0 border-t border-rule bg-paper px-5 py-1.5 text-[12px] text-ink-faint">{PRIVACY}</footer>
      <SettingsDialog />
    </div>
  );
}

/** A normal scrolling page with a readable measure. */
export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="h-full overflow-auto">
      <div className={`mx-auto px-6 py-8 ${wide ? "max-w-[76rem]" : "max-w-[54rem]"}`}>{children}</div>
    </div>
  );
}
