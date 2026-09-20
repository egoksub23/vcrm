"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ExternalLink, Link2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-can";
import type { TicketJira } from "@/hooks/use-ticket-jira";
import { MAX_LINKS_PER_TICKET, type TicketJiraLinkRow } from "@/lib/jira/types";
import { JiraCreateDialog } from "./jira-create-dialog";
import { JiraLinkDialog } from "./jira-link-dialog";
import { TicketJiraCompactRow } from "./jira-compact-row";
import { TicketJiraCard } from "./ticket-jira-card";

/**
 * The Jira block of a ticket (left column, after the attachments): the linked
 * issues as cards, and "Create issue" / "Link existing issue" for people who
 * may. State comes from `useTicketJira` (called once by the ticket view and
 * shared with the activity list); nothing here calls Jira to render.
 */
/** Up to this many linked issues show as full cards; further ones collapse into one-line rows. */
export const FULL_CARDS = 2;

export function TicketJiraSection({ ticketId, jira }: { ticketId: string; jira: TicketJira }) {
  const t = useTranslations("Jira.section");
  const tDepth = useTranslations("Jira.depth");
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const canLink = useCapability("jira.link");
  const canShareCap = useCapability("jira.share-comments");
  const canConnect = useCapability("jira.connect");
  const [createOpen, setCreateOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  if (jira.loading) return null;

  const { links, connection, connected, needsReconnect } = jira;

  if (links.length === 0 && !connected) {
    // Jira is not in use here: only people who can connect it get a nudge.
    if (!canConnect) return null;
    return (
      <p className="text-xs text-muted-foreground">
        {needsReconnect ? t("hintReconnect") : t("hintConnect")}{" "}
        <Link href="/settings?tab=integrations" className="font-medium text-primary hover:underline">
          {t("openSettings")}
        </Link>
      </p>
    );
  }

  const canAdd = connected && canLink && !jira.atLimit;
  const created = (link: TicketJiraLinkRow) => {
    toast.success(t("created", { key: link.issue_key }));
    setCreateOpen(false);
    void jira.reload();
  };
  const linked = (link: TicketJiraLinkRow) => {
    toast.success(t("linked", { key: link.issue_key }));
    setLinkOpen(false);
    void jira.reload();
  };

  return (
    <section aria-label={t("heading")} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
          {t("heading")}
          {links.length > 0 ? <span className="text-xs font-normal text-muted-foreground">{links.length}</span> : null}
        </h3>
        {canAdd ? (
          <div className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="ghost" className="text-primary" onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5" />
              {t("create")}
            </Button>
            <Button size="sm" variant="ghost" className="text-primary" onClick={() => setLinkOpen(true)}>
              <Link2 className="size-3.5" />
              {t("link")}
            </Button>
          </div>
        ) : null}
      </div>

      {connected && canLink && jira.atLimit ? <p className="text-xs text-muted-foreground">{t("limitReached", { max: MAX_LINKS_PER_TICKET })}</p> : null}

      {links.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {canAdd ? t("emptyCanLink") : t("empty")}
        </div>
      ) : (
        <div className="space-y-2">
          {links.map((link, index) => {
            const toggle = () =>
              setOpened((cur) => {
                const next = new Set(cur);
                if (next.has(link.id)) next.delete(link.id);
                else next.add(link.id);
                return next;
              });
            // Beyond the first two, an issue is one line until opened.
            if (index >= FULL_CARDS && !opened.has(link.id)) {
              return <TicketJiraCompactRow key={link.id} link={link} expanded={false} onToggle={toggle} />;
            }
            return (
              <div key={link.id} className="space-y-1">
                {index >= FULL_CARDS ? <TicketJiraCompactRow link={link} expanded onToggle={toggle} /> : null}
                <TicketJiraCard
                  link={link}
                  siteUrl={connection?.siteUrl}
                  canLink={canLink}
                  canShare={canShareCap && jira.commentsToJira}
                  canConnect={canConnect}
                  needsReconnect={needsReconnect}
                  onSync={() => jira.syncNow(link.id)}
                  onUnlink={() => jira.unlink(link.id)}
                  onLoadTransitions={() => jira.listTransitions(link.id)}
                  onTransition={(transitionId) => jira.transition(link.id, transitionId)}
                  onComment={(text) => jira.commentInJira(link.id, text)}
                />
              </div>
            );
          })}
        </div>
      )}

      {jira.skippedFiles.length > 0 ? (
        <div className="space-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
          <p className="font-medium text-foreground">{tDepth("skipped.title", { count: jira.skippedFiles.length })}</p>
          <ul className="space-y-0.5">
            {jira.skippedFiles.slice(0, 10).map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                <span className="min-w-0 break-all">{f.filename ?? tDepth("skipped.unnamed")}</span>
                <span>{tDepth(`skipped.reason.${f.status}`)}</span>
                {f.jiraUrl && /^https?:\/\//i.test(f.jiraUrl) ? (
                  <a href={f.jiraUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                    {tDepth("skipped.open")}
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canAdd ? (
        <>
          <JiraCreateDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            ticketId={ticketId}
            siteUrl={connection?.siteUrl}
            defaultProject={connection?.settings.projects.default_project}
            defaultIssueType={connection?.settings.projects.default_issue_type}
            issueTypeOverrides={Object.fromEntries(Object.entries(connection?.settings.project_overrides ?? {}).flatMap(([k, o]) => (o.issue_type ? [[k, o.issue_type]] : [])))}
            onCreated={created}
          />
          <JiraLinkDialog
            open={linkOpen}
            onOpenChange={setLinkOpen}
            ticketId={ticketId}
            linkedKeys={links.map((l) => l.issue_key)}
            onLinked={linked}
          />
        </>
      ) : null}
    </section>
  );
}
