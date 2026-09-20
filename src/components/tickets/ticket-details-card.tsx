"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { format, formatDistanceToNow } from "date-fns";
import { Eye, EyeOff, MessageSquare, User, X } from "lucide-react";

import { contactHandle } from "@/lib/whatsapp/wa-identity";
import type { KnownLabel } from "@/hooks/use-ticket-labels";
import type { Contact, Profile, Team, Ticket, TicketWatcher } from "@/types";
import { TicketLabelPicker } from "./ticket-label-picker";
import { AssigneeMenu, PriorityMenu, StatusMenu, TeamMenu, TypeMenu } from "./ticket-pickers";
import { TicketSlaSection } from "./ticket-sla-section";
import { PersonAvatar } from "./ticket-visuals";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] items-start gap-2 py-1.5">
      <dt className="pt-1 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-[13px] text-foreground">{children}</dd>
    </div>
  );
}

function When({ iso }: { iso: string }) {
  return (
    <span title={format(new Date(iso), "PPpp")}>
      {formatDistanceToNow(new Date(iso), { addSuffix: true })}
    </span>
  );
}

/** The due date box: saves shortly after a change and on blur, and has a clear button. */
function DueDateField({
  value,
  disabled,
  onCommit,
}: {
  value: string | null | undefined;
  disabled: boolean;
  onCommit: (next: string | null) => void;
}) {
  const t = useTranslations("Tickets.detail");
  const [draft, setDraft] = useState(value ?? "");
  const [seen, setSeen] = useState(value ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if ((value ?? "") !== seen) {
    setSeen(value ?? "");
    setDraft(value ?? "");
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const commit = (next: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (next === (value ?? "")) return;
    if (next !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(next)) return;
    onCommit(next === "" ? null : next);
  };

  return (
    <div className="flex items-center gap-1">
      <input
        type="date"
        value={draft}
        disabled={disabled}
        aria-label={t("dueDate")}
        onChange={(e) => {
          setDraft(e.target.value);
          if (timer.current) clearTimeout(timer.current);
          const next = e.target.value;
          timer.current = setTimeout(() => commit(next), 700);
        }}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(draft);
        }}
        className="h-7 min-w-0 rounded-md border border-input bg-transparent px-1.5 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60 dark:scheme-dark"
      />
      {draft && !disabled ? (
        <button
          type="button"
          onClick={() => {
            setDraft("");
            commit("");
          }}
          aria-label={t("clearDueDate")}
          title={t("clearDueDate")}
          className="rounded p-1 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The right column of the issue view: status transition button and the
 * Details card. Every control saves on commit through `onUpdate` (optimistic
 * with a toast on error, see useTicketDetail); read-only viewers see them
 * disabled.
 */
export function TicketDetailsCard({
  ticket,
  contact,
  members,
  teams,
  watchers,
  watching,
  knownLabels,
  canWork,
  currentUserId,
  onUpdate,
  onToggleWatch,
  onViewContact,
}: {
  ticket: Ticket;
  contact: Contact | null;
  members: Profile[];
  teams: Team[];
  watchers: TicketWatcher[];
  watching: boolean;
  knownLabels: KnownLabel[];
  canWork: boolean;
  currentUserId: string | null;
  onUpdate: (patch: Partial<Ticket>) => void;
  onToggleWatch: () => void;
  onViewContact: () => void;
}) {
  const t = useTranslations("Tickets.detail");
  const tCommon = useTranslations("Tickets.common");
  const reporter = members.find((m) => m.user_id === ticket.created_by);
  const shownWatchers = watchers.slice(0, 6);

  return (
    <div className="space-y-3">
      <StatusMenu status={ticket.status} variant="button" disabled={!canWork} onChange={(status) => onUpdate({ status })} />

      <TicketSlaSection ticket={ticket} />

      <div className="rounded-lg border border-border bg-card">
        <h3 className="border-b border-border px-3 py-2 text-[13px] font-semibold">{t("detailsHeading")}</h3>
        <dl className="divide-y divide-border/60 px-3 py-1">
          <Row label={t("assignee")}>
            <div className="flex flex-col items-start gap-0.5">
              <AssigneeMenu
                assigneeId={ticket.assigned_agent_id}
                members={members}
                disabled={!canWork}
                onChange={(userId) => onUpdate({ assigned_agent_id: userId })}
              />
              {canWork && currentUserId && ticket.assigned_agent_id !== currentUserId ? (
                <button
                  type="button"
                  onClick={() => onUpdate({ assigned_agent_id: currentUserId })}
                  className="text-xs text-primary hover:underline"
                >
                  {t("assignToMe")}
                </button>
              ) : null}
            </div>
          </Row>
          <Row label={t("reporter")}>
            {ticket.created_by ? (
              <span className="flex items-center gap-1.5">
                <PersonAvatar name={reporter?.full_name ?? tCommon("unknownPerson")} avatarUrl={reporter?.avatar_url} />
                <span className="truncate">{reporter?.full_name ?? tCommon("unknownPerson")}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Row>
          {teams.length > 0 ? (
            <Row label={t("team")}>
              <TeamMenu
                teamId={ticket.assigned_team_id}
                teams={teams}
                disabled={!canWork}
                onChange={(assigned_team_id) => onUpdate({ assigned_team_id })}
              />
            </Row>
          ) : null}
          <Row label={t("priorityLabel")}>
            <PriorityMenu priority={ticket.priority} withLabel disabled={!canWork} onChange={(priority) => onUpdate({ priority })} />
          </Row>
          <Row label={t("typeLabel")}>
            <TypeMenu category={ticket.category} disabled={!canWork} onChange={(category) => onUpdate({ category })} />
          </Row>
          <Row label={t("labels")}>
            <TicketLabelPicker
              labels={ticket.labels ?? []}
              known={knownLabels}
              disabled={!canWork}
              onChange={(labels) => onUpdate({ labels })}
            />
          </Row>
          <Row label={t("dueDate")}>
            <DueDateField
              value={ticket.due_date}
              disabled={!canWork}
              onCommit={(due_date) => onUpdate({ due_date })}
            />
          </Row>
          <Row label={t("watchers")}>
            <div className="flex flex-wrap items-center gap-1.5">
              {shownWatchers.length === 0 ? (
                <span className="text-muted-foreground">{t("noWatchers")}</span>
              ) : (
                <span className="flex -space-x-1">
                  {shownWatchers.map((w) => {
                    const p = members.find((m) => m.user_id === w.user_id);
                    return (
                      <PersonAvatar
                        key={w.user_id}
                        name={p?.full_name ?? tCommon("unknownPerson")}
                        avatarUrl={p?.avatar_url}
                        className="ring-2 ring-card"
                      />
                    );
                  })}
                </span>
              )}
              {watchers.length > shownWatchers.length ? (
                <span className="text-xs text-muted-foreground">+{watchers.length - shownWatchers.length}</span>
              ) : null}
              {canWork ? (
                <button
                  type="button"
                  onClick={onToggleWatch}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-primary hover:bg-muted"
                >
                  {watching ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  {watching ? t("unwatch") : t("watch")}
                </button>
              ) : null}
            </div>
          </Row>
          <Row label={t("customer")}>
            <div className="space-y-1">
              {contact ? (
                <p className="flex items-center gap-1.5">
                  <User className="size-3.5 shrink-0 text-muted-foreground" />
                  <button type="button" onClick={onViewContact} className="truncate text-left font-medium hover:underline">
                    {contact.name || contactHandle(contact)}
                  </button>
                </p>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
              {contact?.name && contactHandle(contact) ? (
                <p className="truncate text-xs text-muted-foreground">{contactHandle(contact)}</p>
              ) : null}
              {ticket.conversation_id ? (
                <Link
                  href={`/inbox?c=${ticket.conversation_id}`}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <MessageSquare className="size-3.5" />
                  {t("openConversation")}
                </Link>
              ) : null}
            </div>
          </Row>
        </dl>
      </div>

      <dl className="space-y-0.5 px-1 text-xs text-muted-foreground">
        <div className="flex justify-between gap-2">
          <dt>{t("created")}</dt>
          <dd>
            <When iso={ticket.created_at} />
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>{t("updated")}</dt>
          <dd>
            <When iso={ticket.updated_at} />
          </dd>
        </div>
        {ticket.resolved_at ? (
          <div className="flex justify-between gap-2">
            <dt>{t("resolved")}</dt>
            <dd>
              <When iso={ticket.resolved_at} />
            </dd>
          </div>
        ) : null}
        {ticket.closed_at ? (
          <div className="flex justify-between gap-2">
            <dt>{t("closed")}</dt>
            <dd>
              <When iso={ticket.closed_at} />
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
