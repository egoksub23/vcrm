"use client";

// ============================================================
// Doc Sign, signing page, forms in parts: the overview. The document's title, how many parts are done and
// how far along the person is, every part as a row (its number, its title, where it stands in words and
// when it was last saved), "Continue" to the next part that needs answers, and at the end "Review and
// sign", which stays locked until every required answer is given and says how many parts are left. Parts
// open in any order.
// ============================================================

import { AlertCircle, Check, ChevronRight, CircleDashed, CircleDot, FileSignature, Loader2, Lock, Send } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import type { SaveState } from "@/lib/sign/client/signer-flow";
import { firstUnfinished, partsLeft, rowStatus, savedAgo, type PartRow, type RowStatus } from "@/lib/sign/client/signer-form";
import { overallPercent } from "@/lib/sign/forms/completion";
import { cn } from "@/lib/utils";

import { useFormLocale, useFormText, useNow } from "./form-ui";
import { SaveStatus } from "./save-status";

const CHIP: Record<RowStatus, { icon: typeof Check; tone: string }> = {
  done: { icon: Check, tone: "bg-emerald-500/15 text-foreground" },
  in_progress: { icon: CircleDot, tone: "bg-amber-500/15 text-foreground" },
  not_started: { icon: CircleDashed, tone: "bg-muted text-muted-foreground" },
  needs_change: { icon: AlertCircle, tone: "bg-destructive/15 text-foreground" },
};

function Chip({ status, children, icon, tone }: { status?: RowStatus; children: string; icon?: typeof Check; tone?: string }) {
  const style = status ? CHIP[status] : { icon: icon ?? Check, tone: tone ?? "" };
  const Icon = style.icon;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium", style.tone)}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {children}
    </span>
  );
}

const ROW_BUTTON = "flex min-h-14 w-full touch-manipulation items-center gap-3 rounded-xl border bg-card p-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50";

/** "Saved 2 minutes ago" for one part, in the language of the page. */
function useSavedWords(): (iso: string | null) => string | null {
  const t = useTranslations("Sign.signerForm");
  const locale = useFormLocale();
  const now = useNow();
  return (iso) => {
    const ago = now > 0 ? savedAgo(iso, now) : null;
    if (!ago) return null;
    return ago.kind === "now" ? t("save.savedNow") : t("save.savedAgo", { when: new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(ago.value, ago.unit) });
  };
}

interface FormOverviewProps {
  title: string;
  rows: PartRow[];
  /** The sign step (or the submit step) is open. */
  unlocked: boolean;
  /** The last step sends the answers (a person who only fills in) instead of going on to sign. */
  submit: boolean;
  saveState?: SaveState;
  busy?: boolean;
  lastSavedAt: string | null;
  onOpen: (partKey: string) => void;
  onFinal: () => void;
}

export function FormOverview({ title, rows, unlocked, submit, saveState, busy, lastSavedAt, onOpen, onFinal }: FormOverviewProps) {
  const t = useTranslations("Sign.signerForm");
  const text = useFormText();
  const savedWords = useSavedWords();
  const done = rows.filter((r) => r.state === "done").length;
  const percent = overallPercent(rows);
  const next = firstUnfinished(rows);
  const left = partsLeft(rows);
  const saving = !!busy || saveState === "saving";

  const leftWords = submit ? t("final.leftSubmit", { count: left }) : t("final.leftSign", { count: left });
  const lockedWhy = left > 0 ? leftWords : saving ? t("final.saving") : t("final.check");
  const finalTitle = submit ? t("final.submit") : t("final.review");
  const readyWhy = submit ? t("final.readySubmit") : t("final.readySign");

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold leading-snug break-words">{title}</h1>
        <p className="text-base text-muted-foreground">{t("overview.intro")}</p>
      </header>

      <section aria-label={t("overview.progressLabel")} className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-base font-semibold">{t("overview.partsDone", { done, total: rows.length })}</p>
          <SaveStatus saveState={saveState} busy={busy} lastSavedAt={lastSavedAt} />
        </div>
        <div role="progressbar" aria-label={t("overview.progressLabel")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={t("overview.percent", { percent })} className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-emerald-600 transition-[width] motion-reduce:transition-none " style={{ width: `${percent}%` }} />
        </div>
        <p className="text-xs text-muted-foreground" aria-hidden>
          {t("overview.percent", { percent })}
        </p>
      </section>

      <ol className="space-y-2" aria-label={t("overview.parts")}>
        {rows.map((row) => {
          const status = rowStatus(row);
          const saved = savedWords(row.lastSavedAt ?? null);
          const counts = row.total > 0 && row.state !== "not_started" ? t("overview.counts", { done: row.done, total: row.total }) : null;
          return (
            <li key={row.part.key}>
              <button type="button" className={ROW_BUTTON} onClick={() => onOpen(row.part.key)}>
                <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">
                  {row.number}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-base font-medium leading-snug">{text(row.part.title)}</span>
                  {counts || saved ? <span className="mt-0.5 block text-xs text-muted-foreground">{[counts, saved].filter(Boolean).join(" · ")}</span> : null}
                </span>
                <Chip status={status}>{t(`status.${status}`)}</Chip>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden />
              </button>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            aria-disabled={!unlocked}
            aria-describedby={unlocked ? undefined : "form-final-why"}
            className={cn(ROW_BUTTON, !unlocked && "cursor-not-allowed bg-muted/40 text-muted-foreground hover:bg-muted/40")}
            onClick={() => {
              if (unlocked) onFinal();
            }}
          >
            <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
              {submit ? <Send className="size-4" /> : <FileSignature className="size-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn("block break-words text-base font-medium leading-snug", unlocked && "text-foreground")}>{finalTitle}</span>
              <span id="form-final-why" className="mt-0.5 block text-xs text-muted-foreground">
                {unlocked ? readyWhy : lockedWhy}
              </span>
            </span>
            {unlocked ? <Chip status="done">{t("status.ready")}</Chip> : <Chip icon={Lock} tone="bg-muted text-muted-foreground">{t("status.locked")}</Chip>}
            <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden />
          </button>
        </li>
      </ol>

      {next ? (
        <Button type="button" className="h-auto min-h-12 w-full whitespace-normal px-5 py-2 text-base" onClick={() => onOpen(next.part.key)}>
          {t("overview.continue", { part: text(next.part.title) })}
        </Button>
      ) : unlocked ? (
        <Button type="button" className="h-12 w-full px-5 text-base" onClick={onFinal}>
          {finalTitle}
        </Button>
      ) : saving ? (
        <p role="status" className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
          {t("final.saving")}
        </p>
      ) : null}
    </div>
  );
}
