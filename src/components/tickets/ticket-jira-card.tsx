"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { format, formatDistance } from "date-fns";
import { AlertTriangle, ChevronDown, ExternalLink, Loader2, MessageSquarePlus, RefreshCw, Unlink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { JiraApiResult, JiraShareResult, JiraTransition } from "@/hooks/use-ticket-jira";
import type { TicketJiraLinkRow } from "@/lib/jira/types";
import { bannersFor, categoryTone, errorKeyOf, issueUrlOf, loose, normalizeCategory, retrySeconds, type JiraBanner } from "@/lib/tickets/jira-ui";
import { cn } from "@/lib/utils";

export interface TicketJiraCardProps {
  link: TicketJiraLinkRow;
  /** The Jira site address, used to build the issue link when the row has none cached. */
  siteUrl?: string | null;
  /** The caller holds jira.link: sync, move, unlink. */
  canLink: boolean;
  /** The caller holds jira.share-comments and the workspace lets comments go to Jira. */
  canShare: boolean;
  /** The caller holds jira.connect: the reconnect banner links to Settings. */
  canConnect: boolean;
  /** The workspace connection needs to be reconnected. */
  needsReconnect: boolean;
  /** Fixed clock for tests. */
  now?: Date;
  onSync: () => Promise<JiraApiResult<unknown>>;
  onUnlink: () => Promise<JiraApiResult<unknown>>;
  onLoadTransitions: () => Promise<JiraApiResult<{ transitions: JiraTransition[] }>>;
  onTransition: (transitionId: string) => Promise<JiraApiResult<unknown>>;
  onComment: (text: string) => Promise<JiraApiResult<{ noteId: string; results: JiraShareResult[] }>>;
}

const BANNER_TONE = {
  error: "border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-200",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
} as const;

const BANNER_KIND: Record<JiraBanner, keyof typeof BANNER_TONE> = {
  not_found: "error",
  no_access: "error",
  paused: "warn",
  reconnect: "warn",
  no_transition: "warn",
  screen_fields: "warn",
  permission: "warn",
};

type TransitionsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; items: JiraTransition[] }
  | { status: "error"; code: string; retry?: number };

type Notice = { tone: "ok" | "error"; text: string } | null;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="truncate text-[13px] text-foreground">{children}</dd>
    </div>
  );
}

/**
 * One linked Jira issue, from the cached row: key and summary (a link to Jira),
 * status lozenge, people, priority, and the actions. Presentational: it holds
 * only UI state (menus, confirm, draft) and calls back for everything else.
 * Jira text is untrusted and is only ever rendered as text.
 */
export function TicketJiraCard({
  link,
  siteUrl,
  canLink,
  canShare,
  canConnect,
  needsReconnect,
  now,
  onSync,
  onUnlink,
  onLoadTransitions,
  onTransition,
  onComment,
}: TicketJiraCardProps) {
  const t = useTranslations("Jira");

  const [busy, setBusy] = useState<null | "sync" | "unlink" | "move" | "comment">(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [transitions, setTransitions] = useState<TransitionsState>({ status: "idle" });
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");

  const url = issueUrlOf(link, siteUrl);
  const category = normalizeCategory(link.status_category);
  const banners = bannersFor(link, { needsReconnect });
  const healthy = link.sync_state === "ok" && !needsReconnect;
  const hasActions = canLink || canShare;

  const errorText = (r: { code: string; retryAfterSeconds?: number }) =>
    loose(t)(`errors.${errorKeyOf(r.code)}`, { seconds: retrySeconds(r.retryAfterSeconds) });

  const sync = async () => {
    setBusy("sync");
    setNotice(null);
    const r = await onSync();
    setBusy(null);
    setNotice(r.ok ? { tone: "ok", text: t("card.synced") } : { tone: "error", text: errorText(r) });
  };

  const loadTransitions = async () => {
    setTransitions({ status: "loading" });
    const r = await onLoadTransitions();
    setTransitions(r.ok ? { status: "ready", items: r.data.transitions ?? [] } : { status: "error", code: r.code, retry: r.retryAfterSeconds });
  };

  const move = async (tr: JiraTransition) => {
    setBusy("move");
    setNotice(null);
    const r = await onTransition(tr.id);
    setBusy(null);
    setTransitions({ status: "idle" });
    setNotice(r.ok ? { tone: "ok", text: t("card.moved", { status: tr.to ?? tr.name }) } : { tone: "error", text: errorText(r) });
  };

  const unlink = async () => {
    setBusy("unlink");
    setNotice(null);
    const r = await onUnlink();
    setBusy(null);
    setConfirmUnlink(false);
    // On success the card disappears (the link row is gone); only a failure needs a message.
    if (!r.ok) setNotice({ tone: "error", text: errorText(r) });
  };

  const postComment = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy("comment");
    setNotice(null);
    const r = await onComment(text);
    setBusy(null);
    if (!r.ok) {
      setNotice({ tone: "error", text: errorText(r) });
      return;
    }
    const failed = (r.data.results ?? []).find((x) => !x.ok);
    if (failed) {
      setNotice({ tone: "error", text: t("card.commentPartial", { reason: loose(t)(`errors.${errorKeyOf(failed.code)}`, { seconds: 30 }) }) });
    } else {
      setNotice({ tone: "ok", text: t("card.commentPosted") });
    }
    setDraft("");
    setComposing(false);
  };

  const bannerBody = (b: JiraBanner): ReactNode => {
    switch (b) {
      case "not_found":
        return (
          <>
            <p className="font-medium">{t("banner.notFoundTitle")}</p>
            <p>{t("banner.notFoundBody")}</p>
          </>
        );
      case "no_access":
        return (
          <>
            <p className="font-medium">{t("banner.noAccessTitle")}</p>
            <p>{t("banner.noAccessBody")}</p>
          </>
        );
      case "reconnect":
        return (
          <>
            <p className="font-medium">{t("banner.reconnectTitle")}</p>
            <p>
              {canConnect ? (
                <Link href="/settings?tab=integrations" className="font-medium underline underline-offset-2">
                  {t("banner.reconnectAction")}
                </Link>
              ) : (
                t("banner.reconnectAsk")
              )}
            </p>
          </>
        );
      case "paused":
        return (
          <>
            <p className="font-medium">{t("banner.pausedTitle")}</p>
            <p>{t("banner.pausedBody")}</p>
          </>
        );
      case "no_transition":
        return <p>{t("banner.noTransition")}</p>;
      case "screen_fields":
        return <p>{t("banner.screenFields")}</p>;
      case "permission":
        return <p>{t("banner.permission")}</p>;
    }
  };

  const disabledTitle = canLink ? undefined : t("card.noPermission");
  const actionClass = "text-muted-foreground hover:text-foreground";

  return (
    <article
      aria-label={t("card.label", { key: link.issue_key })}
      data-sync-state={link.sync_state}
      className="min-w-0 space-y-2.5 rounded-lg border border-border bg-card p-3"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <h4 className="min-w-0 text-[13px] leading-snug font-medium break-words text-foreground">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={t("card.openIssueTitle", { key: link.issue_key })}
              className="inline-flex max-w-full items-baseline gap-1.5 hover:underline"
            >
              <span className="font-mono font-semibold text-primary">{link.issue_key}</span>
              <span className="min-w-0 break-words">{link.summary ?? ""}</span>
              <ExternalLink className="size-3 shrink-0 self-center text-muted-foreground" aria-hidden />
            </a>
          ) : (
            <span className="inline-flex max-w-full items-baseline gap-1.5">
              <span className="font-mono font-semibold text-primary">{link.issue_key}</span>
              <span className="min-w-0 break-words">{link.summary ?? ""}</span>
            </span>
          )}
        </h4>
        <span
          className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground"
          title={link.last_synced_at ? format(new Date(link.last_synced_at), "PPpp") : undefined}
        >
          {link.last_synced_at
            ? t("card.updated", { when: formatDistance(new Date(link.last_synced_at), now ?? new Date(), { addSuffix: true }) })
            : t("card.neverSynced")}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {link.status_name ? (
          <span
            title={t(`card.category.${category}` as never)}
            className={cn(
              "inline-flex max-w-full items-center truncate rounded-[4px] px-1.5 py-0.5 text-[11px] leading-none font-bold tracking-wide uppercase",
              categoryTone(category),
            )}
          >
            {link.status_name}
          </span>
        ) : null}
        {link.project_name || link.project_key ? (
          <span className="text-xs text-muted-foreground">{link.project_name ?? link.project_key}</span>
        ) : null}
        {link.issue_type ? <span className="text-xs text-muted-foreground">· {link.issue_type}</span> : null}
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-4">
        <Field label={t("card.assignee")}>{link.assignee_name ?? <span className="text-muted-foreground">{t("card.unassigned")}</span>}</Field>
        <Field label={t("card.reporter")}>{link.reporter_name ?? "—"}</Field>
        <Field label={t("card.priority")}>{link.priority_name ?? "—"}</Field>
        <Field label={t("card.resolution")}>{link.resolution ?? "—"}</Field>
      </dl>

      {banners.map((b) => (
        <div
          key={b}
          role="status"
          data-banner={b}
          className={cn("flex gap-2 rounded-md border px-2.5 py-2 text-xs leading-relaxed", BANNER_TONE[BANNER_KIND[b]])}
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <div className="min-w-0 space-y-0.5">{bannerBody(b)}</div>
        </div>
      ))}

      {notice ? (
        <p
          role="status"
          className={cn("text-xs", notice.tone === "ok" ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300")}
        >
          {notice.text}
        </p>
      ) : null}

      {confirmUnlink ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/40 p-2.5 text-xs">
          <p className="text-foreground">{t("card.unlinkConfirm", { key: link.issue_key })}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={busy === "unlink"} onClick={() => void unlink()}>
              {busy === "unlink" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("card.unlinkYes")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy === "unlink"} onClick={() => setConfirmUnlink(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      {composing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={20000}
            autoFocus
            disabled={busy === "comment"}
            aria-label={t("card.commentLabel")}
            placeholder={t("card.commentPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void postComment();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setComposing(false);
              }
            }}
            className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-primary/50"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy === "comment" || !draft.trim()} onClick={() => void postComment()}>
              {busy === "comment" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("card.commentPost")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy === "comment"} onClick={() => setComposing(false)}>
              {t("common.cancel")}
            </Button>
            <span className="ml-auto text-[11px] text-muted-foreground">{t("card.commentHint")}</span>
          </div>
        </div>
      ) : null}

      {hasActions ? (
        <div className="flex flex-wrap items-center gap-1 border-t border-border pt-2">
          <Button
            size="sm"
            variant="ghost"
            className={actionClass}
            disabled={!canLink || busy !== null}
            title={disabledTitle}
            onClick={() => void sync()}
          >
            {busy === "sync" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {busy === "sync" ? t("card.syncing") : t("card.sync")}
          </Button>

          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[0.8rem] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {t("card.open")}
            </a>
          ) : null}

          <DropdownMenu
            onOpenChange={(open) => {
              if (open) void loadTransitions();
            }}
          >
            <DropdownMenuTrigger
              disabled={!canLink || !healthy || busy !== null}
              title={disabledTitle}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[0.8rem] font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
            >
              {busy === "move" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("card.move")}
              <ChevronDown className="size-3.5" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 border-border bg-popover">
              {transitions.status === "loading" || transitions.status === "idle" ? (
                <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t("card.moveLoading")}
                </div>
              ) : transitions.status === "error" ? (
                <div className="px-2 py-1.5 text-xs text-red-700 dark:text-red-300">
                  {errorText({ code: transitions.code, retryAfterSeconds: transitions.retry })}
                </div>
              ) : transitions.items.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("card.moveNone")}</div>
              ) : (
                transitions.items.map((tr) => (
                  <DropdownMenuItem key={tr.id} disabled={tr.blocked} title={tr.blocked ? t("card.moveBlocked") : undefined} onClick={() => void move(tr)}>
                    <span className="min-w-0 flex-1 truncate">{tr.name}</span>
                    {tr.to && tr.to !== tr.name ? <span className="max-w-24 truncate text-[11px] text-muted-foreground">{tr.to}</span> : null}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            size="sm"
            variant="ghost"
            className={actionClass}
            disabled={!canShare || !healthy || busy !== null || composing}
            title={canShare ? undefined : t("card.noCommentPermission")}
            onClick={() => {
              setNotice(null);
              setComposing(true);
            }}
          >
            <MessageSquarePlus className="size-3.5" />
            {t("card.comment")}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground hover:text-destructive"
            disabled={!canLink || busy !== null || confirmUnlink}
            title={disabledTitle}
            onClick={() => {
              setNotice(null);
              setConfirmUnlink(true);
            }}
          >
            <Unlink className="size-3.5" />
            {t("card.unlink")}
          </Button>
        </div>
      ) : null}
    </article>
  );
}
