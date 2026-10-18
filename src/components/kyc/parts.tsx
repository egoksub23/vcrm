"use client";

// ============================================================
// KYC review, the presentational pieces: they take everything as props (no fetching, no timers), so they render the same in the app and in the render
// tests. Colours are tokens or light-dark() pairs (Tailwind's dark-mode variants do not apply in this app) and a status is always a WORD plus an icon, never
// colour alone.
// ============================================================

import { AlertTriangle, CheckCircle2, CircleHelp, Clock3, Lock, ShieldCheck, XCircle } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { chip, TONE } from "@/components/comments/chips";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { KycField, KycStatus, KycValidation, StatusTone } from "@/lib/kyc/types";

import { errorKey, exactTime, relativeTime, shortId, type ClientErrorCode } from "./helpers";

// ------------------------------------------------------------
// Chips
// ------------------------------------------------------------
const TONE_CLASS: Record<StatusTone, string> = { positive: TONE.ok, pending: TONE.warn, negative: TONE.danger, neutral: TONE.muted };
const TONE_ICON: Record<StatusTone, typeof CheckCircle2> = { positive: CheckCircle2, pending: Clock3, negative: XCircle, neutral: CircleHelp };

export function TypeChip({ type }: { type: string | null }) {
  const t = useTranslations("Kyc.list");
  return <span className={cn(chip, "bg-muted text-foreground uppercase tracking-wide")}>{type ?? t("typeUnknown")}</span>;
}

/** The status: an icon, the word the back end sent (or "Unknown"), and a hidden word for the tone, so it never relies on colour. */
export function StatusChip({ status }: { status: KycValidation["status"] }) {
  const t = useTranslations("Kyc.status");
  const Icon = TONE_ICON[status.tone];
  return (
    <span className={cn(chip, "gap-1", TONE_CLASS[status.tone])} data-tone={status.tone}>
      <Icon className="size-3" aria-hidden />
      <span className="sr-only">{t(status.tone)}: </span>
      <span>{status.raw ? humanStatus(status.raw) : t("unknown")}</span>
    </span>
  );
}

/** NO_ID_ON_CLIENT -> "No id on client", UNREADABLE -> "Unreadable". A status the back end already wrote in words is shown as sent. */
export function humanStatus(raw: string): string {
  if (!/_/.test(raw) && raw !== raw.toUpperCase()) return raw;
  const s = raw.replace(/_+/g, " ").trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ------------------------------------------------------------
// The notices at the top
// ------------------------------------------------------------
export function ReadOnlyNotice() {
  const t = useTranslations("Kyc");
  return (
    <p role="note" className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-foreground">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span>{t("readOnlyNotice")}</span>
    </p>
  );
}

export function UatBanner() {
  const t = useTranslations("Kyc");
  return (
    <p role="note" className="flex items-start gap-2 rounded-lg border border-[color:light-dark(#fcd34d,#92400e)] bg-[color:light-dark(#fffbeb,#78350f40)] px-3 py-2 text-sm text-foreground">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[light-dark(#b45309,#fcd34d)]" aria-hidden />
      <span>{t("uatBanner")}</span>
    </p>
  );
}

export function ProvisionalNote() {
  const t = useTranslations("Kyc");
  return (
    <p role="note" className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
      {t("provisionalNote")}
    </p>
  );
}

/** "Not set up": an administrator is told which variables to set, everyone else to ask one. */
export function SetupNotice({ status }: { status: Pick<KycStatus, "missing" | "isAdmin"> }) {
  const t = useTranslations("Kyc.setup");
  return (
    <section aria-labelledby="kyc-setup-title" className="rounded-xl border border-border bg-card p-4">
      <h2 id="kyc-setup-title" className="font-medium text-foreground">
        {t("title")}
      </h2>
      {status.isAdmin ? (
        <>
          <p className="mt-1 text-sm text-muted-foreground">{t("adminBody")}</p>
          <ul className="mt-2 space-y-1 text-sm">
            {(status.missing.length > 0 ? status.missing : ["KYC_DOC_API_BASE_URL", "KYC_DOC_API_KEY"]).map((name) => (
              <li key={name}>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{name}</code>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">{t("optional")}</p>
        </>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">{t("othersBody")}</p>
      )}
    </section>
  );
}

export function ErrorPanel({ code, isAdmin, onRetry, compact }: { code: ClientErrorCode | string; isAdmin: boolean; onRetry?: () => void; compact?: boolean }) {
  const t = useTranslations("Kyc");
  const key = errorKey(code);
  return (
    <div role="alert" className={cn("rounded-xl border border-[color:light-dark(#fca5a5,#7f1d1d)] bg-[color:light-dark(#fef2f2,#450a0a66)] p-3", compact ? "text-sm" : "p-4")}>
      <p className="flex items-start gap-2 font-medium text-foreground">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[light-dark(#b91c1c,#fca5a5)]" aria-hidden />
        <span>{t(`errors.${key}`)}</span>
      </p>
      {isAdmin && code === "upstream_unauthorized" ? <p className="mt-1 text-sm text-muted-foreground">{t("errors.unauthorizedAdmin")}</p> : null}
      {isAdmin && code === "image_host_blocked" ? <p className="mt-1 text-sm text-muted-foreground">{t("errors.imageHostAdmin")}</p> : null}
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          {t("retry")}
        </Button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------
// The results list
// ------------------------------------------------------------
/** A stable key for a row: the validation's id, or its position when the back end sent none. */
export const rowKey = (v: KycValidation, index: number) => v.id || `row-${index}`;

export function ValidationList({
  items,
  selectedKey,
  onSelect,
  now,
}: {
  items: readonly KycValidation[];
  selectedKey: string | null;
  onSelect: (v: KycValidation, index: number) => void;
  now: number;
}) {
  const t = useTranslations("Kyc.list");
  const locale = useLocale();
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card" aria-label={t("title")}>
      {items.map((v, i) => {
        const key = rowKey(v, i);
        const selected = selectedKey !== null && key === selectedKey;
        return (
          <li key={key}>
            <button
              type="button"
              onClick={() => onSelect(v, i)}
              aria-current={selected ? "true" : undefined}
              data-selected={selected ? "true" : undefined}
              className={cn(
                "flex w-full flex-col gap-1.5 px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
                selected && "bg-muted",
              )}
            >
              <span className="flex flex-wrap items-center gap-1.5">
                <TypeChip type={v.type} />
                <StatusChip status={v.status} />
              </span>
              <span className="flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted-foreground">
                {v.createdAt ? (
                  <time dateTime={v.createdAt} title={exactTime(v.createdAt, locale)}>
                    {relativeTime(v.createdAt, now, locale)}
                  </time>
                ) : (
                  <span>{v.createdAtRaw ?? t("noTime")}</span>
                )}
                <span className="font-mono">{v.id ? shortId(v.id) : t("noId")}</span>
                {v.score ? <span>{t("score", { score: v.score })}</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------
// The data card
// ------------------------------------------------------------
/** One value: the text, or "Hidden" with a lock for a masked one. A partly masked value (15••••••34) is shown as it is, in a fixed-width font. */
export function FieldValue({ field }: { field: KycField }) {
  const t = useTranslations("Kyc.detail");
  if (field.masked) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {field.value === null ? <span className="text-muted-foreground">{t("hidden")}</span> : <span className="font-mono">{field.value}</span>}
        <span className="sr-only">{t("maskedValue")}</span>
      </span>
    );
  }
  return <span className="break-words">{field.value}</span>;
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

const KNOWN_LABEL_KEYS = ["name", "idNumber", "dob", "address"] as const;

export function DataCard({
  v,
  canReveal,
  revealed,
  revealing,
  onReveal,
  onHide,
  now,
}: {
  v: KycValidation;
  canReveal: boolean;
  /** The values shown are the revealed ones (they hide again after two minutes). */
  revealed: boolean;
  revealing: boolean;
  onReveal: () => void;
  onHide: () => void;
  now: number;
}) {
  const t = useTranslations("Kyc.detail");
  const locale = useLocale();
  const all = [...v.known, ...v.extra];
  const anySensitive = all.some((f) => f.sensitive);
  return (
    <section aria-labelledby="kyc-data-title" className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="kyc-data-title" className="font-medium text-foreground">
          {t("dataTitle")}
        </h3>
        {anySensitive ? (
          revealed ? (
            <Button variant="outline" size="sm" onClick={onHide}>
              {t("hideAgain")}
            </Button>
          ) : canReveal && v.hasMasked ? (
            <Button variant="outline" size="sm" onClick={onReveal} disabled={revealing || !v.idUsable}>
              {revealing ? t("revealing") : t("reveal")}
            </Button>
          ) : null
        ) : null}
      </div>
      {anySensitive && revealed ? <p className="mt-1 text-xs text-muted-foreground">{t("revealNote")}</p> : null}
      {anySensitive && !revealed && !canReveal ? <p className="mt-1 text-xs text-muted-foreground">{t("noRevealPermission")}</p> : null}

      <dl className="mt-2 divide-y divide-border">
        {v.type ? <Row label={t("fields.type")}>{v.type}</Row> : null}
        <Row label={t("fields.status")}>
          <StatusChip status={v.status} />
        </Row>
        {v.createdAt || v.createdAtRaw ? (
          <Row label={t("fields.submitted")}>
            {v.createdAt ? (
              <time dateTime={v.createdAt} title={exactTime(v.createdAt, locale)}>
                {exactTime(v.createdAt, locale)} <span className="text-muted-foreground">({relativeTime(v.createdAt, now, locale)})</span>
              </time>
            ) : (
              v.createdAtRaw
            )}
          </Row>
        ) : null}
        {v.updatedAt ? <Row label={t("fields.updated")}>{exactTime(v.updatedAt, locale)}</Row> : null}
        {v.score ? <Row label={t("fields.score")}>{v.score}</Row> : null}
        {v.reason ? <Row label={t("fields.reason")}>{v.reason}</Row> : null}
        {v.known.map((f) => (
          <Row key={f.key} label={(KNOWN_LABEL_KEYS as readonly string[]).includes(f.key) ? t(`fields.${f.key as (typeof KNOWN_LABEL_KEYS)[number]}`) : (f.label ?? f.key)}>
            <FieldValue field={f} />
          </Row>
        ))}
      </dl>

      <h4 className="mt-4 text-sm font-medium text-foreground">{t("otherFields")}</h4>
      {v.extra.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">{t("noOther")}</p>
      ) : (
        <dl className="mt-1 divide-y divide-border">
          {v.extra.map((f) => (
            <Row key={f.key} label={<span className="font-mono text-xs break-all">{f.key}</span>}>
              <FieldValue field={f} />
            </Row>
          ))}
        </dl>
      )}

      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{t("technical")}</summary>
        <dl className="mt-1 divide-y divide-border">
          <Row label={t("fields.validationId")}>
            <span className="font-mono text-xs break-all">{v.id || "—"}</span>
          </Row>
          <Row label={t("fields.rawStatus")}>
            <span className="font-mono text-xs break-all">{v.status.raw ?? "—"}</span>
          </Row>
          {v.friendId ? (
            <Row label={t("fields.friendId")}>
              <span className="font-mono text-xs break-all">{v.friendId}</span>
            </Row>
          ) : null}
          {v.createdAt ? (
            <Row label={t("fields.createdIso")}>
              <span className="font-mono text-xs">{v.createdAt}</span>
            </Row>
          ) : null}
        </dl>
        {v.withheld > 0 ? <p className="mt-1 text-xs text-muted-foreground">{t("withheld", { count: v.withheld })}</p> : null}
      </details>
    </section>
  );
}
