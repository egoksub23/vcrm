"use client";

// Settings > Integrations > Jira > Diagnostics. Health at a glance (token,
// catch-up, webhooks, queue, links, rate limit), recent sync events and dead
// jobs, two repair buttons, and the "what to check first" cheat sheet.
// Presentational; a manual Refresh, no polling.

import type { ReactNode } from "react";
import { Loader2, RefreshCw, Send, TriangleAlert, Webhook } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { SettingsChip } from "../settings-chip";
import type { JiraDiagnostics } from "./jira-api";
import { JiraCard, LoadProblem, LoadingLine } from "./jira-form-parts";

export interface JiraDiagnosticsTabProps {
  /** null while loading. */
  data: JiraDiagnostics | null;
  error: string | null;
  refreshing: boolean;
  /** The repair currently running. */
  action: "webhooks" | "catchup" | "report" | null;
  onRefresh: () => void;
  onRegisterWebhooks: () => void;
  onCatchup: () => void;
  /** "Send now" for the personal-data report (jira.connect). */
  onSendReport?: () => void;
  /** Read one issue again now (allowed once per 30 seconds per link). */
  onResync?: (linkId: string) => void;
  /** The link being resynced, if any. */
  resyncing?: string | null;
}

const CHEAT_ROWS = ["siteAdmin", "projectMissing", "requiredField", "statusNotArriving", "reconnectBanner", "cannotMove"] as const;

export function JiraDiagnosticsTab({
  data,
  error,
  refreshing,
  action,
  onRefresh,
  onRegisterWebhooks,
  onCatchup,
  onSendReport,
  onResync,
  resyncing = null,
}: JiraDiagnosticsTabProps) {
  const t = useTranslations("Settings.jira.diagnostics");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-[62ch] text-sm text-muted-foreground">{t("intro")}</p>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing || action !== null}>
          {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {t("refresh")}
        </Button>
      </div>

      {error ? <LoadProblem message={error} onRetry={onRefresh} /> : null}
      {!error && data === null ? <LoadingLine /> : null}
      {data && !data.connection ? (
        <p className="rounded-xl border border-dashed border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          {t("notConnected")}
        </p>
      ) : null}
      {data?.connection ? (
        <DiagnosticsBody
          data={data}
          action={action}
          onRegisterWebhooks={onRegisterWebhooks}
          onCatchup={onCatchup}
          onSendReport={onSendReport}
          onResync={onResync}
          resyncing={resyncing}
        />
      ) : null}

      <CheatSheet />
    </div>
  );
}

function DiagnosticsBody({
  data,
  action,
  onRegisterWebhooks,
  onCatchup,
  onSendReport,
  onResync,
  resyncing,
}: {
  data: JiraDiagnostics;
  action: JiraDiagnosticsTabProps["action"];
  onRegisterWebhooks: () => void;
  onCatchup: () => void;
  onSendReport?: () => void;
  onResync?: (linkId: string) => void;
  resyncing: string | null;
}) {
  const t = useTranslations("Settings.jira.diagnostics");
  const td = useTranslations("Settings.jira.depth");
  const trust = data.webhookTrust;
  const report = data.report ?? null;
  const conn = data.connection!;
  const needsReconnect = conn.status !== "active";
  const hook = data.webhook;
  const queue = data.queue ?? { pending: 0, running: 0, dead: 0 };
  const links = data.links ?? { ok: 0, paused: 0, broken: 0 };
  const failures = data.failures ?? [];
  const events = data.events ?? [];
  const deadJobs = data.deadJobs ?? [];

  return (
    <>
      {data.catchupStalled ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-800 dark:text-red-200">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">{td("stalled.title")}</p>
            <p className="mt-0.5 text-xs">{td("stalled.body", { minutes: data.catchupMinutes ?? 30 })}</p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label={t("health.connection")}>
          <SettingsChip variant={needsReconnect ? "warn" : "ok"}>
            {t(needsReconnect ? "health.needsReconnect" : "health.connected")}
          </SettingsChip>
          {needsReconnect && conn.statusReason ? (
            <span className="mt-1 block text-xs text-muted-foreground">{conn.statusReason}</span>
          ) : null}
        </Tile>
        <Tile label={t("health.token")} hint={t("health.tokenHint")}>
          <When iso={data.tokenExpiresAt} empty={t("never")} />
        </Tile>
        <Tile label={t("health.catchup")} hint={t("health.catchupHint")}>
          <When iso={data.lastCatchupAt} empty={t("never")} />
        </Tile>
        <Tile label={t("health.report")} hint={t("health.reportHint")}>
          <When iso={data.lastReportAt} empty={t("never")} />
        </Tile>
      </div>

      <JiraCard title={t("webhooks.title")} description={t("webhooks.description")}>
        <div className="flex flex-wrap items-center gap-2">
          <SettingsChip variant={hook?.registered ? "ok" : "warn"}>
            <Webhook aria-hidden />
            {hook?.registered ? t("webhooks.registered", { count: hook.count }) : t("webhooks.none")}
          </SettingsChip>
        </div>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <Tile label={t("webhooks.expires")} plain>
            <When iso={hook?.expiresAt} empty={t("never")} />
          </Tile>
          <Tile label={t("webhooks.checked")} plain>
            <When iso={hook?.checkedAt} empty={t("never")} />
          </Tile>
          <Tile label={t("webhooks.lastDelivery")} plain>
            <When iso={hook?.lastDeliveryAt} empty={t("webhooks.noDelivery")} />
          </Tile>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">{t("webhooks.honest")}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onRegisterWebhooks} disabled={action !== null || needsReconnect}>
            {action === "webhooks" ? <Loader2 className="size-4 animate-spin" /> : <Webhook className="size-4" />}
            {t("webhooks.reregister")}
          </Button>
          <Button variant="outline" size="sm" onClick={onCatchup} disabled={action !== null || needsReconnect}>
            {action === "catchup" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {t("catchupNow")}
          </Button>
        </div>
      </JiraCard>

      <JiraCard title={td("trust.title")} description={td("trust.description")}>
        {trust && trust.unsigned > 0 ? (
          <p role="status" className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
            {td("trust.unsignedNote", { count: trust.unsigned })}
          </p>
        ) : null}
        <div className="grid grid-cols-3 gap-2 text-center">
          <Count label={td("trust.signed")} value={trust?.signed ?? 0} />
          <Count label={td("trust.unsigned")} value={trust?.unsigned ?? 0} bad={(trust?.unsigned ?? 0) > 0} />
          <Count label={td("trust.rejected")} value={trust?.rejectedUnsigned ?? 0} bad={(trust?.rejectedUnsigned ?? 0) > 0} />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {trust?.requireSigned ? td("trust.strictOn") : td("trust.strictOff")}
          {trust?.since ? (
            <>
              {" "}
              {td("trust.sinceLabel")} <When iso={trust.since} empty="" />
            </>
          ) : null}
        </p>
      </JiraCard>

      <JiraCard title={td("report.title")} description={td("report.description")}>
        {report ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <SettingsChip variant={report.ok ? "ok" : "warn"}>{td(report.ok ? "report.ok" : "report.failed")}</SettingsChip>
            <span className="text-muted-foreground">
              {td("report.at")} <When iso={report.at} empty={t("never")} />
            </span>
            {report.ok ? (
              <span className="text-xs text-muted-foreground">{td("report.counts", { reported: report.reported ?? 0, erased: report.erased ?? 0, refreshed: report.refreshed ?? 0 })}</span>
            ) : (
              <span className="min-w-0 text-xs break-words text-muted-foreground">{report.error}</span>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{td("report.never")}</p>
        )}
        {onSendReport ? (
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={onSendReport} disabled={action !== null || needsReconnect}>
              {action === "report" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {td("report.sendNow")}
            </Button>
          </div>
        ) : null}
      </JiraCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <JiraCard title={t("queue.title")} description={t("queue.description")}>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Count label={t("queue.pending")} value={queue.pending} />
            <Count label={t("queue.running")} value={queue.running} />
            <Count label={t("queue.dead")} value={queue.dead} bad={queue.dead > 0} />
          </div>
        </JiraCard>
        <JiraCard title={t("links.title")} description={t("links.description")}>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Count label={t("links.ok")} value={links.ok} />
            <Count label={t("links.paused")} value={links.paused} bad={links.paused > 0} />
            <Count label={t("links.broken")} value={links.broken} bad={links.broken > 0} />
          </div>
        </JiraCard>
      </div>

      {failures.length > 0 ? (
        <JiraCard title={t("failures.title")} description={t("failures.description")}>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {failures.map((f) => (
              <li key={f.linkId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className="font-mono text-xs font-semibold text-foreground">{f.key}</span>
                <SettingsChip variant="warn">{t(f.state === "paused" ? "failures.paused" : "failures.broken")}</SettingsChip>
                {f.error ? (
                  <span className="min-w-0 text-xs text-muted-foreground">
                    {f.error === "not_found" || f.error === "no_access" ? t(`failures.error.${f.error}`) : f.error}
                  </span>
                ) : null}
                {onResync ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => onResync(f.linkId)}
                    disabled={resyncing !== null || action !== null || f.state === "paused"}
                  >
                    {resyncing === f.linkId ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                    {t("failures.resync")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </JiraCard>
      ) : null}

      <JiraCard title={t("rateLimit.title")} description={t("rateLimit.description")}>
        {data.rateLimit ? (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <Tile label={t("rateLimit.reason")} plain>
              {data.rateLimit.reason || t("rateLimit.noReason")}
            </Tile>
            <Tile label={t("rateLimit.remaining")} plain>
              {data.rateLimit.remaining ?? "-"}
            </Tile>
            <Tile label={t("rateLimit.limit")} plain>
              {data.rateLimit.limit ?? "-"}
            </Tile>
            <Tile label={t("rateLimit.at")} plain>
              <When iso={data.rateLimit.at} empty={t("never")} />
            </Tile>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t("rateLimit.none")}</p>
        )}
      </JiraCard>

      <JiraCard title={t("events.title")} description={t("events.description")}>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("events.empty")}</p>
        ) : (
          <ul className="max-h-96 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
                <LevelChip level={e.level} />
                <span className="font-mono text-xs text-muted-foreground">{e.kind}</span>
                <span className="min-w-0 flex-1 basis-56 text-sm text-foreground">{e.message}</span>
                <span className="text-xs whitespace-nowrap text-muted-foreground">
                  <When iso={e.created_at} empty="" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </JiraCard>

      <JiraCard title={t("deadJobs.title")} description={t("deadJobs.description")}>
        {deadJobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("deadJobs.empty")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {deadJobs.map((j) => (
              <li key={j.id} className="space-y-0.5 px-3 py-2">
                <p className="flex flex-wrap items-center gap-x-3 text-sm">
                  <span className="font-mono text-xs font-semibold text-foreground">{j.kind}</span>
                  <span className="text-xs text-muted-foreground">{t("deadJobs.attempts", { count: j.attempts })}</span>
                  <span className="text-xs text-muted-foreground">
                    <When iso={j.finished_at} empty="" />
                  </span>
                </p>
                {j.last_error ? <p className="text-xs break-words text-muted-foreground">{j.last_error}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </JiraCard>
    </>
  );
}

function CheatSheet() {
  const t = useTranslations("Settings.jira.diagnostics.cheatSheet");
  return (
    <JiraCard title={t("title")} description={t("description")}>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
              <th scope="col" className="w-1/3 px-3 py-2 font-medium">
                {t("symptom")}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("cause")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {CHEAT_ROWS.map((row) => (
              <tr key={row} className="align-top">
                <th scope="row" className="px-3 py-2 font-medium text-foreground">
                  {t(`${row}.symptom`)}
                </th>
                <td className="px-3 py-2 text-muted-foreground">{t(`${row}.cause`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </JiraCard>
  );
}

// ------------------------------------------------------------
// Bits
// ------------------------------------------------------------

function Tile({
  label,
  hint,
  children,
  plain,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  /** Inside a <dl>, without the card border. */
  plain?: boolean;
}) {
  const body = (
    <>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-foreground">
        {children}
        {hint ? <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">{hint}</span> : null}
      </dd>
    </>
  );
  return plain ? (
    <div className="min-w-0">{body}</div>
  ) : (
    <dl className="min-w-0 rounded-xl border border-border bg-card p-3">{body}</dl>
  );
}

function Count({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <div className="rounded-lg border border-border px-2 py-2">
      <p className={cn("text-xl font-semibold tabular-nums", bad ? "text-amber-600 dark:text-amber-300" : "text-foreground")}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function LevelChip({ level }: { level: string }) {
  const t = useTranslations("Settings.jira.diagnostics.events");
  const known = level === "info" || level === "warn" || level === "error";
  return (
    <SettingsChip
      variant={level === "warn" ? "warn" : "muted"}
      className={level === "error" ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300" : undefined}
    >
      {known ? t(`level.${level}`) : level}
    </SettingsChip>
  );
}

/** A relative time with the exact time as its tooltip. */
function When({ iso, empty }: { iso: string | null | undefined; empty: string }) {
  const format = useFormatter();
  if (!iso) return <>{empty}</>;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return <>{empty}</>;
  return (
    <time dateTime={iso} title={format.dateTime(date, { dateStyle: "medium", timeStyle: "medium" })}>
      {format.relativeTime(date)}
    </time>
  );
}
