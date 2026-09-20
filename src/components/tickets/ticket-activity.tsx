"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { format, formatDistanceToNow } from "date-fns";
import { ArrowDownUp, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createClient } from "@/lib/supabase/client";
import { endOfDueDay } from "@/lib/tickets/due";
import type { LinkedTicket } from "@/hooks/use-ticket-detail";
import type {
  Profile,
  Team,
  TicketActivity,
  TicketComment,
  TicketFieldDefinition,
} from "@/types";
import { MentionTextarea } from "./ticket-mention-textarea";
import { PersonAvatar } from "./ticket-visuals";

type Tab = "all" | "comments" | "history";

type Item =
  | { kind: "comment"; id: string; at: string; comment: TicketComment }
  | { kind: "activity"; id: string; at: string; event: TicketActivity };

const splitLabels = (v: string | null | undefined) => (v ? v.split(",").filter(Boolean) : []);

const NO_NOTES: ReadonlySet<string> = new Set();

function relative(iso: string) {
  return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

/**
 * Activity: comments and history, with tabs (All / Comments / History), a
 * newest-first toggle and, like Jira, the comment box on top ("Add a
 * comment..." until focused, then Save / Cancel, Ctrl+Enter saves). Comments
 * can be edited and deleted by their author.
 */
export function TicketActivitySection({
  comments,
  activity,
  members,
  teams,
  fieldDefs,
  linked,
  keyOf,
  canWork,
  currentUserId,
  onAddComment,
  onEditComment,
  onDeleteComment,
  canShareToJira = false,
  jiraSharedNoteIds = NO_NOTES,
  onShareToJira,
}: {
  comments: TicketComment[];
  activity: TicketActivity[];
  members: Profile[];
  teams: Team[];
  fieldDefs: TicketFieldDefinition[];
  linked: Record<string, LinkedTicket>;
  keyOf: (n: number) => string;
  canWork: boolean;
  currentUserId: string | null;
  onAddComment: (body: string, mentions: string[]) => Promise<boolean>;
  onEditComment: (id: string, body: string) => Promise<boolean>;
  onDeleteComment: (id: string) => Promise<boolean>;
  /**
   * "Share with Jira" on notes written here: true only when the caller may, the
   * workspace lets notes go to Jira, Jira is connected and a link is healthy.
   */
  canShareToJira?: boolean;
  /** Notes already posted to Jira: they show "Shared with Jira" instead. */
  jiraSharedNoteIds?: ReadonlySet<string>;
  onShareToJira?: (noteId: string) => Promise<boolean>;
}) {
  const t = useTranslations("Tickets.detail");
  const tAct = useTranslations("Tickets.detail.activity");
  const tCommon = useTranslations("Tickets.common");
  const tLinks = useTranslations("Tickets.links");
  const tActivity = useTranslations("Tickets.activity");

  const [tab, setTab] = useState<Tab>("all");
  const [newestFirst, setNewestFirst] = useState(true);

  // New comment
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [mentioned, setMentioned] = useState<Set<string>>(new Set());
  const [posting, setPosting] = useState(false);

  // Editing one
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);

  // Other tickets named by link events that are no longer linked.
  const [extraKeys, setExtraKeys] = useState<Record<string, number>>({});
  const linkIds = useMemo(
    () =>
      [...new Set(activity.filter((a) => a.event_type === "link_added" || a.event_type === "link_removed").map((a) => a.to_value).filter((x): x is string => !!x))].filter(
        (id) => !linked[id] && extraKeys[id] === undefined,
      ),
    [activity, linked, extraKeys],
  );
  useEffect(() => {
    if (linkIds.length === 0) return;
    let cancelled = false;
    void createClient()
      .from("tickets")
      .select("id, ticket_number")
      .in("id", linkIds)
      .then(({ data }) => {
        if (cancelled) return;
        const found = Object.fromEntries(((data as { id: string; ticket_number: number }[]) ?? []).map((r) => [r.id, r.ticket_number]));
        // Ids that no longer exist are remembered as 0 so they are not asked for again.
        setExtraKeys((prev) => ({ ...prev, ...Object.fromEntries(linkIds.map((id) => [id, found[id] ?? 0])) }));
      });
    return () => {
      cancelled = true;
    };
  }, [linkIds]);

  const nameOf = (id: string | null | undefined) => members.find((m) => m.user_id === id)?.full_name ?? tCommon("unknownPerson");
  const teamName = (id: string | null | undefined) => teams.find((tm) => tm.id === id)?.name ?? tCommon("noTeam");
  const status = (v: string | null | undefined) => (v ? tCommon(`status.${v}` as never) : "—");
  const priority = (v: string | null | undefined) => (v ? tCommon(`priority.${v}` as never) : "—");
  const type = (v: string | null | undefined) => (v ? tCommon(`type.${v}` as never) : "—");
  const date = (v: string | null | undefined) => {
    const end = v ? endOfDueDay(v) : null;
    return end ? format(end, "PP") : "—";
  };
  const ticketRef = (id: string | null | undefined) => {
    if (!id) return tActivity("aTicket");
    const n = linked[id]?.ticket_number ?? extraKeys[id];
    return n ? keyOf(n) : tActivity("aTicket");
  };

  const describe = (a: TicketActivity): string => {
    switch (a.event_type) {
      case "created":
        return tAct("created");
      case "status_changed":
        return tAct("statusChanged", { from: status(a.from_value), to: status(a.to_value) });
      case "priority_changed":
        return tAct("priorityChanged", { from: priority(a.from_value), to: priority(a.to_value) });
      case "category_changed":
        return tAct("typeChanged", { from: type(a.from_value), to: type(a.to_value) });
      case "assigned_agent_changed":
        if (!a.to_value) return tAct("unassignedAgent", { from: nameOf(a.from_value) });
        if (!a.from_value) return tAct("assignedAgent", { to: nameOf(a.to_value) });
        return tAct("reassignedAgent", { from: nameOf(a.from_value), to: nameOf(a.to_value) });
      case "assigned_team_changed":
        if (!a.to_value) return tAct("unassignedTeam", { from: teamName(a.from_value) });
        if (!a.from_value) return tAct("assignedTeam", { to: teamName(a.to_value) });
        return tAct("reassignedTeam", { from: teamName(a.from_value), to: teamName(a.to_value) });
      case "custom_field_changed": {
        const def = fieldDefs.find((d) => d.id === a.field_id);
        const field = def?.label ?? tAct("unknownField");
        const show = (v: string | null | undefined) => (v == null ? "" : def?.field_type === "checkbox" ? tAct("yes") : v);
        if (!a.to_value) return tAct("customFieldCleared", { field });
        if (!a.from_value) return tAct("customFieldSet", { field, to: show(a.to_value) });
        return tAct("customFieldChanged", { field, from: show(a.from_value), to: show(a.to_value) });
      }
      case "due_date_changed":
        if (!a.to_value) return tAct("dueCleared", { from: date(a.from_value) });
        if (!a.from_value) return tAct("dueSet", { to: date(a.to_value) });
        return tAct("dueChanged", { from: date(a.from_value), to: date(a.to_value) });
      case "labels_changed": {
        const before = splitLabels(a.from_value);
        const after = splitLabels(a.to_value);
        const added = after.filter((l) => !before.includes(l));
        const removed = before.filter((l) => !after.includes(l));
        const parts: string[] = [];
        if (added.length) parts.push(tAct("labelsAdded", { labels: added.join(", "), count: added.length }));
        if (removed.length) parts.push(tAct("labelsRemoved", { labels: removed.join(", "), count: removed.length }));
        return parts.join("; ") || tAct("labelsChanged");
      }
      case "summary_changed":
        return tAct("summaryChanged", { from: a.from_value ?? "—", to: a.to_value ?? "—" });
      case "description_changed":
        return tAct("descriptionChanged");
      case "link_added":
        return tAct("linkAdded", { relation: tLinks(`group.${a.from_value ?? "relates"}` as never), ticket: ticketRef(a.to_value) });
      case "link_removed":
        return tAct("linkRemoved", { relation: tLinks(`group.${a.from_value ?? "relates"}` as never), ticket: ticketRef(a.to_value) });
      case "attachment_added":
        return tAct("attachmentAdded", { name: a.to_value ?? "" });
      case "jira_linked":
        return tAct("jiraLinked", { key: a.to_value ?? a.detail ?? "" });
      case "jira_unlinked":
        return tAct("jiraUnlinked", { key: a.to_value ?? a.detail ?? "" });
      case "jira_status_synced":
        return tAct("jiraStatusSynced", { from: status(a.from_value), to: status(a.to_value), key: a.detail ?? "" });
      case "jira_status_pushed":
        return tAct("jiraStatusPushed", { key: a.detail ?? "", status: a.to_value ?? "—" });
      default:
        return a.event_type;
    }
  };

  const items: Item[] = useMemo(() => {
    const all: Item[] = [
      ...(tab !== "history" ? comments.map((c): Item => ({ kind: "comment", id: c.id, at: c.created_at, comment: c })) : []),
      ...(tab !== "comments" ? activity.map((e): Item => ({ kind: "activity", id: e.id, at: e.created_at, event: e })) : []),
    ];
    all.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    return newestFirst ? all.reverse() : all;
  }, [comments, activity, tab, newestFirst]);

  const cancelNew = () => {
    setExpanded(false);
    setDraft("");
    setMentioned(new Set());
  };

  const submitNew = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    // Only people whose @name is still in the text are notified.
    const ids = [...mentioned].filter((id) => body.includes(`@${nameOf(id)}`));
    const ok = await onAddComment(body, ids);
    setPosting(false);
    if (ok) cancelNew();
  };

  const submitEdit = async () => {
    if (!editingId || !editDraft.trim() || editing) return;
    setEditing(true);
    const ok = await onEditComment(editingId, editDraft);
    setEditing(false);
    if (ok) setEditingId(null);
  };

  const showBox = tab !== "history";

  // Notes that came from Jira belong to a Jira person: no Edit / Delete, never shared back.
  const canEditNote = (c: TicketComment) => canWork && !!currentUserId && c.source !== "jira" && c.author_id === currentUserId;
  const isSharedNote = (c: TicketComment) => c.source !== "jira" && jiraSharedNoteIds.has(c.id);
  const canShareNote = (c: TicketComment) => canShareToJira && !!onShareToJira && c.source !== "jira" && !!c.author_id && !jiraSharedNoteIds.has(c.id);
  const shareNote = async (id: string) => {
    if (!onShareToJira || sharingId) return;
    setSharingId(id);
    await onShareToJira(id);
    setSharingId(null);
  };

  return (
    <section aria-label={t("activityHeading")} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">{t("activityHeading")}</h3>
        <div className="flex items-center gap-2">
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList variant="line">
              <TabsTrigger value="all">{t("tabAll")}</TabsTrigger>
              <TabsTrigger value="comments">{t("tabComments")}</TabsTrigger>
              <TabsTrigger value="history">{t("tabHistory")}</TabsTrigger>
            </TabsList>
          </Tabs>
          <button
            type="button"
            onClick={() => setNewestFirst((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowDownUp className="size-3.5" />
            {newestFirst ? t("newestFirst") : t("oldestFirst")}
          </button>
        </div>
      </div>

      {showBox ? (
        <div className="flex gap-2.5">
          <PersonAvatar name={nameOf(currentUserId)} avatarUrl={members.find((m) => m.user_id === currentUserId)?.avatar_url} size="lg" />
          <div className="min-w-0 flex-1 space-y-2">
            {expanded && canWork ? (
              <>
                <MentionTextarea
                  value={draft}
                  onValueChange={setDraft}
                  onMention={(id) => setMentioned((prev) => new Set(prev).add(id))}
                  members={members}
                  placeholder={t("commentPlaceholder")}
                  aria-label={t("commentLabel")}
                  rows={3}
                  autoFocus
                  disabled={posting}
                  onSubmit={() => void submitNew()}
                  onCancel={cancelNew}
                />
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => void submitNew()} disabled={posting || !draft.trim()}>
                    {posting ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {t("save")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={cancelNew} disabled={posting}>
                    {t("cancel")}
                  </Button>
                  <span className="ml-auto text-[11px] text-muted-foreground">{t("commentHint")}</span>
                </div>
              </>
            ) : (
              <button
                type="button"
                disabled={!canWork}
                onClick={() => setExpanded(true)}
                onFocus={() => canWork && setExpanded(true)}
                className="h-9 w-full rounded-lg border border-border bg-card px-3 text-left text-[13px] text-muted-foreground transition-colors hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t("addComment")}
              </button>
            )}
          </div>
        </div>
      ) : null}

      <ul className="space-y-3">
        {items.length === 0 ? <li className="text-xs text-muted-foreground">{t("noActivity")}</li> : null}
        {items.map((item) =>
          item.kind === "comment" ? (
            <li key={item.id} className="flex gap-2.5">
              <PersonAvatar
                name={item.comment.source === "jira" ? (item.comment.jira_author ?? tAct("jiraUnknownAuthor")) : nameOf(item.comment.author_id)}
                avatarUrl={item.comment.source === "jira" ? null : members.find((m) => m.user_id === item.comment.author_id)?.avatar_url}
                size="lg"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                  {item.comment.source === "jira" ? (
                    <span
                      data-jira-note="yes"
                      className="inline-flex max-w-full items-center rounded-[4px] bg-blue-500/15 px-1.5 py-0.5 text-[11px] leading-none font-semibold text-blue-700 dark:text-blue-300"
                    >
                      <span className="truncate">{tAct("jiraNoteTag", { author: item.comment.jira_author ?? tAct("jiraUnknownAuthor") })}</span>
                    </span>
                  ) : (
                    <span className="text-[13px] font-semibold text-foreground">{nameOf(item.comment.author_id)}</span>
                  )}
                  <span title={format(new Date(item.comment.created_at), "PPpp")}>{relative(item.comment.created_at)}</span>
                  {item.comment.edited_at ? (
                    <span title={format(new Date(item.comment.edited_at), "PPpp")}>{t("edited")}</span>
                  ) : null}
                  {item.comment.deleted_in_jira ? <span className="italic">{tAct("jiraDeleted")}</span> : null}
                </div>
                {editingId === item.id ? (
                  <div className="mt-1 space-y-2">
                    <MentionTextarea
                      value={editDraft}
                      onValueChange={setEditDraft}
                      members={members}
                      rows={3}
                      autoFocus
                      disabled={editing}
                      aria-label={t("commentLabel")}
                      onSubmit={() => void submitEdit()}
                      onCancel={() => setEditingId(null)}
                    />
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={() => void submitEdit()} disabled={editing || !editDraft.trim()}>
                        {editing ? <Loader2 className="size-3.5 animate-spin" /> : null}
                        {t("save")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} disabled={editing}>
                        {t("cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p
                      className={`mt-0.5 text-[13px] leading-relaxed whitespace-pre-wrap ${item.comment.deleted_in_jira ? "text-muted-foreground" : "text-foreground"}`}
                    >
                      {item.comment.body}
                    </p>
                    {canEditNote(item.comment) || canShareNote(item.comment) || isSharedNote(item.comment) ? (
                      <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                        {canShareNote(item.comment) ? (
                          <button
                            type="button"
                            disabled={sharingId === item.id}
                            onClick={() => void shareNote(item.id)}
                            className="hover:text-foreground hover:underline disabled:opacity-60"
                          >
                            {sharingId === item.id ? tAct("sharingWithJira") : tAct("shareWithJira")}
                          </button>
                        ) : null}
                        {isSharedNote(item.comment) ? <span>{tAct("sharedWithJira")}</span> : null}
                        {canEditNote(item.comment) ? (
                          <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(item.id);
                            setEditDraft(item.comment.body);
                          }}
                          className="hover:text-foreground hover:underline"
                        >
                          {t("edit")}
                        </button>
                        {confirmDeleteId === item.id ? (
                          <span className="flex items-center gap-2">
                            {t("deleteCommentConfirm")}
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmDeleteId(null);
                                void onDeleteComment(item.id);
                              }}
                              className="font-medium text-destructive hover:underline"
                            >
                              {t("delete")}
                            </button>
                            <button type="button" onClick={() => setConfirmDeleteId(null)} className="hover:text-foreground hover:underline">
                              {t("cancel")}
                            </button>
                          </span>
                        ) : (
                          <button type="button" onClick={() => setConfirmDeleteId(item.id)} className="hover:text-destructive hover:underline">
                            {t("delete")}
                          </button>
                        )}
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </li>
          ) : (
            <li key={item.id} className="flex items-start gap-2.5 text-xs text-muted-foreground">
              <span className="flex size-8 shrink-0 items-center justify-center">
                <span className="size-1.5 rounded-full bg-border" />
              </span>
              <div className="min-w-0 flex-1 pt-1.5">
                {item.event.actor_id && item.event.event_type !== "jira_status_synced" ? (
                  <span className="font-medium text-foreground">{nameOf(item.event.actor_id)} </span>
                ) : null}
                <span className="break-words">{describe(item.event)}</span>
                <span className="ml-2" title={format(new Date(item.event.created_at), "PPpp")}>
                  {relative(item.event.created_at)}
                </span>
              </div>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
