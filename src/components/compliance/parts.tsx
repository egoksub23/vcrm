"use client";

// ============================================================
// Compliance requests, the presentational pieces: they take everything as props (no fetching, no timers), so they render the same in the app and in
// the render tests. Colours are tokens or light-dark() pairs (Tailwind's dark-mode variants do not apply in this app) and a status or a clock is always
// a WORD plus an icon, never colour alone.
// ============================================================

import { AlertTriangle, CheckCircle2, Circle, CircleDot, Clock3, Lock, PauseCircle, ShieldAlert, Timer } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { chip, TONE } from "@/components/comments/chips";
import { computeClock, type ClockView } from "@/lib/compliance/clock";
import { STEPS, stepIndexOf } from "@/lib/compliance/transitions";
import type { PersonRef, RequestStatus, RequestSummary } from "@/lib/compliance/types";
import { cn } from "@/lib/utils";

import { CLOCK_TONE, STATUS_TONE, clockLine, typeLabel, type Tone } from "./helpers";

const TONE_CLASS: Record<Tone, string> = { neutral: TONE.muted, info: TONE.primary, warn: TONE.warn, ok: TONE.ok, danger: TONE.danger };

// ------------------------------------------------------------
// Chips
// ------------------------------------------------------------
export function StatusChip({ status }: { status: RequestStatus }) {
  const t = useTranslations("Compliance.status");
  return (
    <span className={cn(chip, "px-2 py-0.5 text-[11px]", TONE_CLASS[STATUS_TONE[status]])} data-status={status}>
      {t(status)}
    </span>
  );
}

export function TypeChip({ request }: { request: Pick<RequestSummary, "typeLabel" | "typeLabelL10n"> }) {
  const locale = useLocale();
  return <span className={cn(chip, "bg-muted px-2 py-0.5 text-[11px] text-foreground")}>{typeLabel(request, locale)}</span>;
}

const CLOCK_ICON: Record<ClockView["state"], typeof Clock3> = {
  none: Circle,
  on_track: Timer,
  target_passed: AlertTriangle,
  near_stop: ShieldAlert,
  breached: ShieldAlert,
  paused: PauseCircle,
  done: CheckCircle2,
};

/** The state of the clock as an icon and a word ("Past target", "Near hard stop", "Breached", ...), amber or red, never colour alone. */
export function ClockChip({ view }: { view: ClockView }) {
  const t = useTranslations("Compliance.clock.state");
  const Icon = CLOCK_ICON[view.state];
  return (
    <span className={cn(chip, "gap-1 px-2 py-0.5 text-[11px]", TONE_CLASS[CLOCK_TONE[view.state]])} data-clock={view.state} data-level={view.level}>
      <Icon className="size-3" aria-hidden />
      <span>{t(view.state)}</span>
    </span>
  );
}

/** "Day 9 of 14 target · 21 days to stop" (or its shorter forms). */
export function ClockText({ view }: { view: ClockView }) {
  const t = useTranslations("Compliance.clock");
  const line = clockLine(view);
  return (
    <span>
      {t(line.key, line.values)}
      {line.stop ? <> · {t(line.stop.key, { count: line.stop.count })}</> : null}
    </span>
  );
}

/** The clock cell of a list row: the chip and the line under it. */
export function ClockCell({ request, now }: { request: RequestSummary; now: number }) {
  const view = computeClock(
    {
      status: request.status,
      receivedAt: request.receivedAt,
      targetDays: request.targetDays,
      hardStopDays: request.hardStopDays,
      targetDueAt: request.targetDueAt,
      hardStopAt: request.hardStopAt,
      pausedAt: request.pausedAt,
      completedAt: request.completedAt,
      closedAt: request.closedAt,
    },
    now,
  );
  return (
    <div className="flex flex-col items-start gap-1">
      <ClockChip view={view} />
      <span className="text-xs text-muted-foreground">
        <ClockText view={view} />
      </span>
    </div>
  );
}

// ------------------------------------------------------------
// People and notices
// ------------------------------------------------------------
export function Person({ person, fallback }: { person: PersonRef | null | undefined; fallback?: string }) {
  const t = useTranslations("Compliance");
  if (!person) return <span className="text-muted-foreground">{fallback ?? t("unassigned")}</span>;
  return <span>{person.name ?? t("formerMember")}</span>;
}

export function Notice({ tone = "neutral", icon, children }: { tone?: "neutral" | "warn" | "danger"; icon?: ReactNode; children: ReactNode }) {
  return (
    <p
      role={tone === "danger" ? "alert" : "note"}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm text-foreground",
        tone === "warn" && "border-[color:light-dark(#fcd34d,#92400e)] bg-[color:light-dark(#fffbeb,#78350f40)]",
        tone === "danger" && "border-[color:light-dark(#fca5a5,#7f1d1d)] bg-[color:light-dark(#fef2f2,#450a0a66)]",
        tone === "neutral" && "border-border bg-muted/50",
      )}
    >
      {icon ?? <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
      <span>{children}</span>
    </p>
  );
}

/** The chip-shaped count of the list's header: a button that applies a filter. */
export function CountButton({ label, count, active, onClick, tone }: { label: string; count: number; active: boolean; onClick: () => void; tone: Tone }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex min-w-0 flex-col items-start rounded-xl border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-muted",
      )}
    >
      <span className={cn("text-xl font-semibold tabular-nums", count > 0 && tone === "danger" && "text-destructive", count > 0 && tone === "warn" && "text-[light-dark(#92400e,#fcd34d)]")}>{count}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </button>
  );
}

// ------------------------------------------------------------
// The step bar: Received > Identity check > Officer review > Sign-off > Execution > Closed
// ------------------------------------------------------------
export function StepBar({ status }: { status: RequestStatus }) {
  const t = useTranslations("Compliance.steps");
  const at = stepIndexOf(status);
  const rejected = status === "rejected";
  return (
    <ol aria-label={t("label")} className="flex items-center gap-1 overflow-x-auto rounded-xl border border-border bg-card px-2 py-2 text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {STEPS.map((step, i) => {
        const done = i < at || status === "closed";
        const current = i === at && status !== "closed";
        const Icon = done ? CheckCircle2 : current ? CircleDot : Circle;
        return (
          <li key={step} aria-current={current ? "step" : undefined} data-step={step} data-state={done ? "done" : current ? "current" : "todo"} className="flex shrink-0 items-center gap-1">
            {i > 0 ? <span aria-hidden className="mx-0.5 h-px w-3 bg-border" /> : null}
            <Icon className={cn("size-4", done ? "text-[light-dark(#047857,#6ee7b7)]" : current ? (rejected ? "text-destructive" : "text-primary") : "text-muted-foreground")} aria-hidden />
            <span className={cn("whitespace-nowrap", current ? "font-semibold text-foreground" : "text-muted-foreground")}>
              {t(step)}
              {current && rejected && step === "signoff" ? ` (${t("rejected")})` : ""}
            </span>
            <span className="sr-only">{done ? ` (${t("done")})` : current ? ` (${t("current")})` : ""}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** A panel with a heading; `id` gives the heading an anchor. */
export function Panel({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-sm font-semibold text-foreground">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A label and its value, stacked on a phone and side by side on a wide screen. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 py-1.5 sm:grid-cols-[11rem_1fr] sm:gap-3">
      <dt className="text-xs font-medium text-muted-foreground sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}
