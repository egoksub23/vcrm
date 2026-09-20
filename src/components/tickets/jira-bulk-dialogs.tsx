"use client";

// Bulk Jira actions on the tickets list (0.45.0): "Create Jira issues" (one per
// selected ticket, with a REVIEW step) and "Link to Jira issue" (all selected
// tickets to ONE issue). At most 25 tickets. The work is queued on the server
// and runs through the same create / link code as the single buttons; these
// dialogs start it and show the progress and the per-ticket results.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, CircleDashed, ExternalLink, Link2, Loader2, MinusCircle, Plus } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { bulkApi, MAX_BULK_TICKETS, useBulkProgress, useJiraConnected, type BulkProgress, type BulkProposal, type BulkReview } from "@/hooks/use-jira-bulk";
import { useCapability } from "@/hooks/use-can";
import { jiraApi, type JiraApiError, type JiraApiResult, type JiraProject } from "@/hooks/use-ticket-jira";
import { errorKeyOf, loose } from "@/lib/tickets/jira-ui";
import { cn } from "@/lib/utils";

import { JIRA_INPUT_CLASS, JiraErrorNotice } from "./jira-form-parts";

export interface BulkTicket {
  id: string;
  /** VIR-12 */
  key: string;
  subject: string;
}

const BAR_BUTTON =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

/** The two buttons for the bulk bar. Nothing shows without jira.link and an active connection. */
export function JiraBulkActions({ tickets, onDone }: { tickets: BulkTicket[]; onDone?: () => void }) {
  const t = useTranslations("Jira.bulk");
  const canLink = useCapability("jira.link");
  const { active: connected, siteUrl } = useJiraConnected();
  const [mode, setMode] = useState<null | "create" | "link">(null);
  if (!canLink || !connected) return null;
  const tooMany = tickets.length > MAX_BULK_TICKETS;

  return (
    <>
      <button type="button" className={BAR_BUTTON} disabled={tooMany} title={tooMany ? t("tooMany", { max: MAX_BULK_TICKETS }) : undefined} onClick={() => setMode("create")}>
        <Plus className="size-3.5 text-muted-foreground" aria-hidden />
        {t("createButton")}
      </button>
      <button type="button" className={BAR_BUTTON} disabled={tooMany} title={tooMany ? t("tooMany", { max: MAX_BULK_TICKETS }) : undefined} onClick={() => setMode("link")}>
        <Link2 className="size-3.5 text-muted-foreground" aria-hidden />
        {t("linkButton")}
      </button>
      <JiraBulkCreateDialog open={mode === "create"} onOpenChange={(o) => !o && setMode(null)} tickets={tickets} siteUrl={siteUrl} onDone={onDone} />
      <JiraBulkLinkDialog open={mode === "link"} onOpenChange={(o) => !o && setMode(null)} tickets={tickets} siteUrl={siteUrl} onDone={onDone} />
    </>
  );
}

// ------------------------------------------------------------
// Presentational pieces (rendered in tests)
// ------------------------------------------------------------

/** One line per ticket: what would be created, and what cannot be. */
export function BulkReviewList({ proposals }: { proposals: BulkProposal[] }) {
  const t = useTranslations("Jira.bulk");
  return (
    <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border" aria-label={t("create.reviewHeading")}>
      {proposals.map((p) => (
        <li key={p.ticketId} className={cn("space-y-1 px-3 py-2", !p.canCreate && "bg-amber-500/5")}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs font-semibold text-foreground">{p.ticketKey || "?"}</span>
            <span className="min-w-0 flex-1 basis-40 text-[13px] break-words text-foreground">{p.summary || p.subject}</span>
            {p.canCreate ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:text-emerald-200">
                <CheckCircle2 className="size-3" aria-hidden />
                {t("create.willCreate")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:text-amber-200">
                <CircleAlert className="size-3" aria-hidden />
                {t("create.cannot")}
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {p.projectKey} · {p.issueTypeName ?? "?"}
          </p>
          {!p.canCreate ? (
            <p className="text-xs text-amber-900 dark:text-amber-200">{reasonText(t, p)}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function reasonText(t: ReturnType<typeof useTranslations>, p: BulkProposal): string {
  const fields = (p.fields ?? []).slice(0, 6).join(", ");
  switch (p.reason) {
    case "link_limit":
      return loose(t)("reasons.link_limit");
    case "unsupported_fields":
      return loose(t)("reasons.unsupported_fields", { fields });
    case "required_fields":
      return loose(t)("reasons.required_fields", { fields });
    default:
      return loose(t)("reasons.not_found");
  }
}

const STATUS_ICON = {
  pending: CircleDashed,
  running: Loader2,
  done: CheckCircle2,
  failed: CircleAlert,
  skipped: MinusCircle,
} as const;

/** The progress bar and the per-ticket results of a running or finished batch. */
export function BulkProgressView({ progress, labelOf, siteUrl }: { progress: BulkProgress; labelOf: (ticketId: string) => string; siteUrl?: string | null }) {
  const t = useTranslations("Jira.bulk.progress");
  const tErr = useTranslations("Jira.errors");
  const settled = progress.counts.done + progress.counts.failed + progress.counts.skipped;
  const pct = progress.total > 0 ? Math.round((settled / progress.total) * 100) : 0;

  return (
    <div className="space-y-3" aria-live="polite">
      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>{progress.finished ? t("finished") : t("running", { done: settled, total: progress.total })}</span>
          <span>{pct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className={cn("h-full rounded-full transition-all", progress.counts.failed > 0 ? "bg-amber-500" : "bg-primary")} style={{ width: `${pct}%` }} />
        </div>
        {progress.finished ? (
          <p className="mt-2 text-sm font-medium text-foreground">{t("summary", { done: progress.counts.done, failed: progress.counts.failed, skipped: progress.counts.skipped })}</p>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">{t("background")}</p>
        )}
      </div>
      <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
        {progress.items.map((i) => {
          const Icon = STATUS_ICON[i.status];
          const url = i.issue_key && siteUrl ? `${siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(i.issue_key)}` : null;
          return (
            <li key={i.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-[13px]">
              <Icon
                className={cn("size-4 shrink-0", i.status === "running" && "animate-spin text-primary", i.status === "done" && "text-emerald-600 dark:text-emerald-300", i.status === "failed" && "text-red-600 dark:text-red-300", (i.status === "pending" || i.status === "skipped") && "text-muted-foreground")}
                aria-hidden
              />
              <span className="font-mono text-xs font-semibold text-foreground">{labelOf(i.ticket_id)}</span>
              <span className="text-xs text-muted-foreground">{t(`status.${i.status}`)}</span>
              {i.issue_key ? (
                url ? (
                  <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono text-xs font-semibold text-primary hover:underline">
                    {i.issue_key}
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                ) : (
                  <span className="font-mono text-xs font-semibold text-foreground">{i.issue_key}</span>
                )
              ) : null}
              {i.code && (i.status === "failed" || i.status === "skipped") ? (
                <span className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground">{loose(tErr)(errorKeyOf(i.code), { seconds: 30 })}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------
// Containers
// ------------------------------------------------------------

function useFinishedToast(progress: BulkProgress | null, onDone?: () => void) {
  const t = useTranslations("Jira.bulk.progress");
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (!progress?.finished || told.current === progress.batchId) return;
    told.current = progress.batchId;
    const { done, failed, skipped } = progress.counts;
    (failed > 0 ? toast.warning : toast.success)(t("toast", { done, failed, skipped }));
    onDone?.();
  }, [progress, onDone, t]);
}

function BulkShell({ open, onOpenChange, title, description, children, footer }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; children: ReactNode; footer: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto bg-popover text-popover-foreground sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function JiraBulkCreateDialog({ open, onOpenChange, tickets, siteUrl, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; tickets: BulkTicket[]; siteUrl?: string | null; onDone?: () => void }) {
  const t = useTranslations("Jira.bulk.create");
  return (
    <BulkShell
      open={open}
      onOpenChange={onOpenChange}
      title={t("title", { count: tickets.length })}
      description={t("description")}
      footer={null}
    >
      {open ? <BulkCreateBody tickets={tickets} siteUrl={siteUrl} onClose={() => onOpenChange(false)} onDone={onDone} /> : null}
    </BulkShell>
  );
}

function BulkCreateBody({ tickets, siteUrl, onClose, onDone }: { tickets: BulkTicket[]; siteUrl?: string | null; onClose: () => void; onDone?: () => void }) {
  const t = useTranslations("Jira.bulk.create");
  const tc = useTranslations("Jira.bulk");
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [project, setProject] = useState<string>("");
  const [issueTypeId, setIssueTypeId] = useState<string>("");
  const [review, setReview] = useState<{ key: string; result: JiraApiResult<BulkReview> } | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<JiraApiError | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const { progress } = useBulkProgress(batchId);
  useFinishedToast(progress, onDone);

  const ids = useMemo(() => tickets.map((x) => x.id), [tickets]);
  const labels = useMemo(() => new Map(tickets.map((x) => [x.id, x.key])), [tickets]);

  useEffect(() => {
    void jiraApi.projects().then((r) => {
      if (r.ok) setProjects(r.data.projects);
    });
  }, []);

  // The review follows the project and issue type; nothing is written by it.
  const reviewKey = `${project}|${issueTypeId}`;
  useEffect(() => {
    if (batchId) return;
    let cancelled = false;
    void bulkApi.review(ids, project || undefined, issueTypeId || undefined).then((r) => {
      if (cancelled) return;
      setReview({ key: reviewKey, result: r });
      if (r.ok) {
        setProject((p) => p || r.data.project);
        setIssueTypeId((i) => i || r.data.issueType.id);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ids, project, issueTypeId, reviewKey, batchId]);

  const loading = !review || review.key !== reviewKey;
  const data = review?.result.ok ? review.result.data : null;
  const creatable = (data?.proposals ?? []).filter((p) => p.canCreate);
  const blocked = (data?.proposals ?? []).length - creatable.length;

  async function start() {
    if (!data) return;
    setStarting(true);
    setStartError(null);
    const r = await bulkApi.create(creatable.map((p) => ({ ticketId: p.ticketId, projectKey: p.projectKey, issueTypeId: p.issueTypeId, issueTypeName: p.issueTypeName, summary: p.summary })));
    setStarting(false);
    if (!r.ok) setStartError(r);
    else setBatchId(r.data.batchId);
  }

  if (batchId) {
    return (
      <>
        {progress ? <BulkProgressView progress={progress} labelOf={(id) => labels.get(id) ?? "?"} siteUrl={siteUrl} /> : <LoadingLine label={t("starting")} />}
        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            {progress?.finished ? tc("close") : tc("closeBackground")}
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-foreground">{t("project")}</span>
          <select
            className={JIRA_INPUT_CLASS}
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setIssueTypeId("");
            }}
          >
            {project && !projects.some((p) => p.key.toUpperCase() === project.toUpperCase()) ? <option value={project}>{project}</option> : null}
            {projects.map((p) => (
              <option key={p.id} value={p.key.toUpperCase()}>
                {p.key} · {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-foreground">{t("issueType")}</span>
          <select className={JIRA_INPUT_CLASS} value={issueTypeId} disabled={!data} onChange={(e) => setIssueTypeId(e.target.value)}>
            {(data?.issueTypes ?? []).map((it) => (
              <option key={it.id} value={it.id}>
                {it.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="space-y-2" aria-label={t("reviewHeading")}>
        <h4 className="text-[13px] font-semibold text-foreground">{t("reviewHeading")}</h4>
        <p className="text-xs text-muted-foreground">{t("reviewHint")}</p>
        {loading ? (
          <LoadingLine label={t("loading")} />
        ) : review && !review.result.ok ? (
          <JiraErrorNotice error={review.result} />
        ) : data ? (
          <>
            <BulkReviewList proposals={data.proposals} />
            <p className="text-xs text-muted-foreground">{t("counts", { create: creatable.length, blocked })}</p>
          </>
        ) : null}
      </section>
      {startError ? <JiraErrorNotice error={startError} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={starting}>
          {tc("cancel")}
        </Button>
        <Button onClick={() => void start()} disabled={loading || starting || creatable.length === 0}>
          {starting ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("confirm", { count: creatable.length })}
        </Button>
      </div>
    </>
  );
}

export function JiraBulkLinkDialog({ open, onOpenChange, tickets, siteUrl, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; tickets: BulkTicket[]; siteUrl?: string | null; onDone?: () => void }) {
  const t = useTranslations("Jira.bulk.link");
  return (
    <BulkShell open={open} onOpenChange={onOpenChange} title={t("title", { count: tickets.length })} description={t("description")} footer={null}>
      {open ? <BulkLinkBody tickets={tickets} siteUrl={siteUrl} onClose={() => onOpenChange(false)} onDone={onDone} /> : null}
    </BulkShell>
  );
}

function BulkLinkBody({ tickets, siteUrl, onClose, onDone }: { tickets: BulkTicket[]; siteUrl?: string | null; onClose: () => void; onDone?: () => void }) {
  const t = useTranslations("Jira.bulk.link");
  const tc = useTranslations("Jira.bulk");
  const [reference, setReference] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<JiraApiError | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const { progress } = useBulkProgress(batchId);
  useFinishedToast(progress, onDone);
  const labels = useMemo(() => new Map(tickets.map((x) => [x.id, x.key])), [tickets]);

  async function start() {
    setStarting(true);
    setError(null);
    const r = await bulkApi.link(
      tickets.map((x) => x.id),
      reference.trim(),
    );
    setStarting(false);
    if (!r.ok) setError(r);
    else setBatchId(r.data.batchId);
  }

  if (batchId) {
    return (
      <>
        {progress ? (
          <>
            {progress.targetIssueKey ? <p className="text-sm text-foreground">{t("target", { key: progress.targetIssueKey })}</p> : null}
            <BulkProgressView progress={progress} labelOf={(id) => labels.get(id) ?? "?"} siteUrl={siteUrl} />
          </>
        ) : (
          <LoadingLine label={t("starting")} />
        )}
        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            {progress?.finished ? tc("close") : tc("closeBackground")}
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-foreground">{t("reference")}</span>
        <input
          className={JIRA_INPUT_CLASS}
          value={reference}
          maxLength={500}
          placeholder={t("placeholder")}
          onChange={(e) => setReference(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && reference.trim() && !starting) void start();
          }}
        />
        <span className="block text-[11px] text-muted-foreground">{t("hint")}</span>
      </label>
      <ul className="max-h-40 divide-y divide-border overflow-y-auto rounded-lg border border-border" aria-label={t("ticketsHeading")}>
        {tickets.map((x) => (
          <li key={x.id} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
            <span className="font-mono text-xs font-semibold">{x.key}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{x.subject}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t("limit")}</p>
      {error ? <JiraErrorNotice error={error} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={starting}>
          {tc("cancel")}
        </Button>
        <Button onClick={() => void start()} disabled={!reference.trim() || starting}>
          {starting ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("confirm", { count: tickets.length })}
        </Button>
      </div>
    </>
  );
}

function LoadingLine({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      {label}
    </p>
  );
}
