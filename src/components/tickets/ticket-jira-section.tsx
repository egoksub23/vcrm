"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Link2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-can";
import type { TicketJira } from "@/hooks/use-ticket-jira";
import { MAX_LINKS_PER_TICKET, type TicketJiraLinkRow } from "@/lib/jira/types";
import { JiraCreateDialog } from "./jira-create-dialog";
import { JiraLinkDialog } from "./jira-link-dialog";
import { TicketJiraCard } from "./ticket-jira-card";

/**
 * The Jira block of a ticket (left column, after the attachments): the linked
 * issues as cards, and "Create issue" / "Link existing issue" for people who
 * may. State comes from `useTicketJira` (called once by the ticket view and
 * shared with the activity list); nothing here calls Jira to render.
 */
export function TicketJiraSection({ ticketId, jira }: { ticketId: string; jira: TicketJira }) {
  const t = useTranslations("Jira.section");
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
          {links.map((link) => (
            <TicketJiraCard
              key={link.id}
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
          ))}
        </div>
      )}

      {canAdd ? (
        <>
          <JiraCreateDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            ticketId={ticketId}
            siteUrl={connection?.siteUrl}
            defaultProject={connection?.settings.projects.default_project}
            defaultIssueType={connection?.settings.projects.default_issue_type}
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
