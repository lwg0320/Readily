// Small shared pieces: icons, chips, buttons.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { ItemStatus, Verdict } from "../types";
import { STATUS_LABEL, VERDICT_LABEL } from "./labels";

type IconName = "check" | "cross" | "alert" | "question" | "split" | "flag" | "gear" | "left" | "right" | "external" | "search" | "clock";

const PATHS: Record<IconName, ReactNode> = {
  check: <path d="M3.5 8.5l3 3 6-7" />,
  cross: <path d="M4 4l8 8M12 4l-8 8" />,
  alert: (
    <>
      <path d="M8 2.2L14.3 13H1.7L8 2.2z" />
      <path d="M8 6.5v3.2M8 11.4v.1" />
    </>
  ),
  question: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.3 6.4a1.8 1.8 0 113 1.3c-.7.6-1.3.9-1.3 1.8M8 11.6v.1" />
    </>
  ),
  split: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2v12" />
      <path d="M8 2a6 6 0 010 12z" fill="currentColor" stroke="none" />
    </>
  ),
  flag: <path d="M4 14V2.5h7.5l-1.6 2.8 1.6 2.8H4" />,
  gear: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" />
    </>
  ),
  left: <path d="M10 3L5 8l5 5" />,
  right: <path d="M6 3l5 5-5 5" />,
  external: <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.3" />
      <path d="M10.3 10.3L14 14" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.3 1.5" />
    </>
  ),
};

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className}`}>
      {PATHS[name]}
    </svg>
  );
}

const VERDICT_STYLE: Record<Verdict, { icon: IconName; cls: string }> = {
  conflict: { icon: "alert", cls: "bg-conflict-wash text-conflict" },
  needs_review: { icon: "question", cls: "bg-review-wash text-review" },
  partial: { icon: "split", cls: "bg-partial-wash text-partial" },
  not_found: { icon: "cross", cls: "bg-notfound-wash text-notfound" },
  covered: { icon: "check", cls: "bg-covered-wash text-covered" },
};

/** Always an icon and a word, never colour alone. */
export function VerdictChip({ verdict, count, size = "md" }: { verdict: Verdict; count?: number; size?: "sm" | "md" }) {
  const s = VERDICT_STYLE[verdict];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-sm font-semibold whitespace-nowrap ${s.cls} ${size === "sm" ? "px-1.5 py-0.5 text-[12px]" : "px-2 py-1 text-[13px]"}`}>
      <Icon name={s.icon} />
      {VERDICT_LABEL[verdict]}
      {count !== undefined && <span className="font-normal tabular-nums">{count}</span>}
    </span>
  );
}

const STATUS_STYLE: Record<ItemStatus, { icon: IconName; cls: string }> = {
  covered: { icon: "check", cls: "text-covered" },
  not_covered: { icon: "cross", cls: "text-notfound" },
  conflict: { icon: "alert", cls: "text-conflict" },
  needs_review: { icon: "question", cls: "text-review" },
};

export function StatusMark({ status }: { status: ItemStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] font-semibold ${s.cls}`}>
      <Icon name={s.icon} />
      {STATUS_LABEL[status]}
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "secondary" | "quiet" };

export function Button({ kind = "secondary", className = "", ...rest }: ButtonProps) {
  const base = "inline-flex items-center justify-center gap-2 rounded px-3.5 py-2 text-[14px] font-semibold leading-tight disabled:cursor-not-allowed disabled:opacity-45";
  const kinds = {
    primary: "bg-stamp text-white hover:bg-stamp-dark",
    secondary: "border border-rule bg-paper text-ink hover:border-ink-faint",
    quiet: "text-stamp hover:bg-stamp-wash",
  };
  return <button type="button" className={`${base} ${kinds[kind]} ${className}`} {...rest} />;
}

/** A thin progress bar with its numbers said in words beside it by the caller. */
export function Bar({ done, total, tone = "stamp" }: { done: number; total: number; tone?: "stamp" | "ink" }) {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-rule-soft" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <div className={`h-full rounded-full ${tone === "stamp" ? "bg-stamp" : "bg-ink-soft"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
