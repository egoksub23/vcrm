"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import { Loader2, Send, Ticket as TicketIcon, User as UserIcon } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { contactHandle } from "@/lib/whatsapp/wa-identity";
import type {
  Contact,
  Profile,
  Team,
  Ticket,
  TicketActivity,
  TicketCategory,
  TicketComment,
  TicketPriority,
  TicketStatus,
} from "@/types";

const STATUSES: TicketStatus[] = ["open", "pending", "resolved", "closed"];
const PRIORITIES: TicketPriority[] = ["urgent", "high", "normal", "low"];
const CATEGORIES: TicketCategory[] = [
  "general",
  "billing",
  "technical",
  "feature_request",
  "bug",
  "account",
  "other",
];

const PRIORITY_COLOR: Record<TicketPriority, string> = {
  urgent: "text-red-500",
  high: "text-amber-500",
  normal: "text-muted-foreground",
  low: "text-sky-500",
};

const STATUS_COLOR: Record<TicketStatus, string> = {
  open: "text-sky-500",
  pending: "text-amber-500",
  resolved: "text-emerald-500",
  closed: "text-muted-foreground",
};

interface TicketDetailSheetProps {
  ticketId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Lets the list page refresh its row without waiting for realtime. */
  onChanged?: () => void;
}

/**
 * Full ticket view — status/priority/category/assignment controls,
 * description, and a comment thread with @mention support (mirrors the
 * inbox's internal-comment @mention picker, scoped to this component
 * since that one lives inline in message-composer.tsx).
 */
export function TicketDetailSheet({
  ticketId,
  onOpenChange,
  onChanged,
}: TicketDetailSheetProps) {
  const t = useTranslations("Tickets.detail");
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [activity, setActivity] = useState<TicketActivity[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingField, setSavingField] = useState<string | null>(null);

  const [commentBody, setCommentBody] = useState("");
  const [mentionedIds, setMentionedIds] = useState<Set<string>>(new Set());
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [postingComment, setPostingComment] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const open = !!ticketId;

  const load = useCallback(async () => {
    if (!ticketId) return;
    setLoading(true);
    const supabase = createClient();
    const [
      { data: ticketRow },
      { data: commentRows },
      { data: activityRows },
      { data: profileRows },
      { data: teamRows },
    ] = await Promise.all([
      supabase.from("tickets").select("*").eq("id", ticketId).maybeSingle(),
      supabase
        .from("ticket_comments")
        .select("*")
        .eq("ticket_id", ticketId)
        .order("created_at", { ascending: true }),
      supabase
        .from("ticket_activity")
        .select("*")
        .eq("ticket_id", ticketId)
        .order("created_at", { ascending: true }),
      supabase.from("profiles").select("*").order("full_name"),
      supabase.from("teams").select("id, account_id, name, description, color, created_at, updated_at").order("name"),
    ]);

    setTicket((ticketRow as Ticket) ?? null);
    setComments((commentRows as TicketComment[]) ?? []);
    setActivity((activityRows as TicketActivity[]) ?? []);
    setProfiles((profileRows as Profile[]) ?? []);
    setTeams((teamRows as Team[]) ?? []);

    if (ticketRow?.contact_id) {
      const { data: contactRow } = await supabase
        .from("contacts")
        .select("*")
        .eq("id", ticketRow.contact_id)
        .maybeSingle();
      setContact((contactRow as Contact) ?? null);
    } else {
      setContact(null);
    }
    setLoading(false);
  }, [ticketId]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!ticketId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`ticket-activity-${ticketId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "ticket_activity", filter: `ticket_id=eq.${ticketId}` },
        (payload) => {
          setActivity((prev) => [...prev, payload.new as TicketActivity]);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [ticketId]);

  const updateField = useCallback(
    async (patch: Partial<Ticket>, fieldKey: string) => {
      if (!ticket) return;
      setSavingField(fieldKey);
      const supabase = createClient();
      const { error } = await supabase.from("tickets").update(patch).eq("id", ticket.id);
      if (error) {
        toast.error(t("updateFailed"));
      } else {
        setTicket((prev) => (prev ? { ...prev, ...patch } : prev));
        onChanged?.();
      }
      setSavingField(null);
    },
    [ticket, onChanged, t],
  );

  const handleStatusChange = (status: TicketStatus) => {
    const patch: Partial<Ticket> = { status };
    if (status === "resolved") patch.resolved_at = new Date().toISOString();
    if (status === "closed") patch.closed_at = new Date().toISOString();
    if (status === "open" || status === "pending") {
      patch.resolved_at = null;
      patch.closed_at = null;
    }
    void updateField(patch, "status");
  };

  // ---- Comment composer with a lightweight @mention autocomplete -----
  const handleCommentChange = (value: string) => {
    setCommentBody(value);
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const match = before.match(/(?:^|\s)@(\w*)$/);
    setMentionQuery(match ? match[1] : null);
  };

  const mentionMatches = mentionQuery === null
    ? []
    : profiles
        .filter((p) => p.full_name.toLowerCase().includes(mentionQuery.toLowerCase()))
        .slice(0, 6);

  const insertMention = (candidate: Profile) => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? commentBody.length;
    const before = commentBody.slice(0, caret);
    const after = commentBody.slice(caret);
    const atIndex = before.lastIndexOf("@");
    if (atIndex === -1) return;
    const newBefore = `${before.slice(0, atIndex)}@${candidate.full_name} `;
    setCommentBody(newBefore + after);
    setMentionedIds((prev) => new Set(prev).add(candidate.user_id));
    setMentionQuery(null);
    requestAnimationFrame(() => el?.focus());
  };

  const handlePostComment = async () => {
    const trimmed = commentBody.trim();
    if (!ticket || !trimmed) return;
    setPostingComment(true);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("ticket_comments")
      .insert({
        ticket_id: ticket.id,
        account_id: ticket.account_id,
        author_id: user?.id ?? null,
        body: trimmed,
        mentions: Array.from(mentionedIds),
      })
      .select("*")
      .single();

    if (error || !data) {
      toast.error(t("commentFailed"));
    } else {
      setComments((prev) => [...prev, data as TicketComment]);
      setCommentBody("");
      setMentionedIds(new Set());
    }
    setPostingComment(false);
  };

  const assignedProfile = profiles.find((p) => p.user_id === ticket?.assigned_agent_id);
  const commentAuthorName = (authorId: string | null | undefined) =>
    profiles.find((p) => p.user_id === authorId)?.full_name ?? t("unknownAgent");
  const profileName = (userId: string | null | undefined) =>
    profiles.find((p) => p.user_id === userId)?.full_name ?? t("unknownAgent");
  const teamName = (teamId: string | null | undefined) =>
    teams.find((tm) => tm.id === teamId)?.name ?? t("noTeam");

  const describeActivity = (a: TicketActivity): string => {
    switch (a.event_type) {
      case "created":
        return t("activity.created");
      case "status_changed":
        return t("activity.statusChanged", {
          from: a.from_value ? t(`status.${a.from_value}` as never) : "—",
          to: a.to_value ? t(`status.${a.to_value}` as never) : "—",
        });
      case "priority_changed":
        return t("activity.priorityChanged", {
          from: a.from_value ? t(`priority.${a.from_value}` as never) : "—",
          to: a.to_value ? t(`priority.${a.to_value}` as never) : "—",
        });
      case "category_changed":
        return t("activity.categoryChanged", {
          from: a.from_value ? t(`category.${a.from_value}` as never) : "—",
          to: a.to_value ? t(`category.${a.to_value}` as never) : "—",
        });
      case "assigned_agent_changed":
        if (!a.to_value) return t("activity.unassignedAgent", { from: profileName(a.from_value) });
        if (!a.from_value) return t("activity.assignedAgent", { to: profileName(a.to_value) });
        return t("activity.reassignedAgent", { from: profileName(a.from_value), to: profileName(a.to_value) });
      case "assigned_team_changed":
        if (!a.to_value) return t("activity.unassignedTeam", { from: teamName(a.from_value) });
        if (!a.from_value) return t("activity.assignedTeam", { to: teamName(a.to_value) });
        return t("activity.reassignedTeam", { from: teamName(a.from_value), to: teamName(a.to_value) });
      default:
        return a.event_type;
    }
  };

  type TimelineItem =
    | { kind: "comment"; id: string; created_at: string; comment: TicketComment }
    | { kind: "activity"; id: string; created_at: string; activityEvent: TicketActivity };

  const timeline: TimelineItem[] = [
    ...comments.map((c): TimelineItem => ({ kind: "comment", id: c.id, created_at: c.created_at, comment: c })),
    ...activity.map((a): TimelineItem => ({ kind: "activity", id: a.id, created_at: a.created_at, activityEvent: a })),
  ].sort((x, y) => new Date(x.created_at).getTime() - new Date(y.created_at).getTime());

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onOpenChange(false)}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0 flex flex-col"
      >
        {loading || !ticket ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <SheetHeader className="border-b border-border/50 p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <TicketIcon className="size-3.5" />
                <span>{t("ticketNumber", { number: ticket.ticket_number })}</span>
              </div>
              <SheetTitle className="text-popover-foreground">{ticket.subject}</SheetTitle>
              {contact && (
                <SheetDescription className="text-muted-foreground text-xs">
                  {contact.name || contactHandle(contact)}
                </SheetDescription>
              )}

              <div className="mt-2 grid grid-cols-2 gap-2">
                <Select value={ticket.status} onValueChange={(v) => handleStatusChange(v as TicketStatus)}>
                  <SelectTrigger className={cn("w-full bg-muted", STATUS_COLOR[ticket.status])}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => (
                      <SelectItem key={s} value={s} className={STATUS_COLOR[s]}>
                        {t(`status.${s}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={ticket.priority}
                  onValueChange={(v) => void updateField({ priority: v as TicketPriority }, "priority")}
                >
                  <SelectTrigger className={cn("w-full bg-muted", PRIORITY_COLOR[ticket.priority])}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p} className={PRIORITY_COLOR[p]}>
                        {t(`priority.${p}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={ticket.category}
                  onValueChange={(v) => void updateField({ category: v as TicketCategory }, "category")}
                >
                  <SelectTrigger className="w-full bg-muted">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {t(`category.${c}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={ticket.assigned_agent_id ?? "__unassigned__"}
                  onValueChange={(v) =>
                    void updateField(
                      { assigned_agent_id: v === "__unassigned__" ? null : v },
                      "assigned_agent_id",
                    )
                  }
                >
                  <SelectTrigger className="w-full bg-muted">
                    <SelectValue placeholder={t("unassigned")}>
                      <span className="flex items-center gap-1.5 truncate">
                        <UserIcon className="size-3 shrink-0" />
                        {assignedProfile?.full_name ?? t("unassigned")}
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__unassigned__">{t("unassigned")}</SelectItem>
                    {profiles.map((p) => (
                      <SelectItem key={p.user_id} value={p.user_id}>
                        {p.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {teams.length > 0 && (
                <Select
                  value={ticket.assigned_team_id ?? "__none__"}
                  onValueChange={(v) =>
                    void updateField(
                      { assigned_team_id: v === "__none__" ? null : v },
                      "assigned_team_id",
                    )
                  }
                >
                  <SelectTrigger className="w-full bg-muted">
                    <SelectValue placeholder={t("noTeam")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">{t("noTeam")}</SelectItem>
                    {teams.map((tm) => (
                      <SelectItem key={tm.id} value={tm.id}>
                        {tm.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {savingField && (
                <span className="text-[11px] text-muted-foreground">{t("saving")}</span>
              )}
            </SheetHeader>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {ticket.description && (
                <p className="whitespace-pre-wrap text-sm text-foreground">{ticket.description}</p>
              )}

              <div className="border-t border-border/50 pt-3">
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("historyHeading")}
                </h4>
                <div className="space-y-2">
                  {timeline.length === 0 && (
                    <p className="text-xs text-muted-foreground">{t("noComments")}</p>
                  )}
                  {timeline.map((item) =>
                    item.kind === "comment" ? (
                      <div
                        key={item.id}
                        className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-2.5"
                      >
                        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {commentAuthorName(item.comment.author_id)}
                          </span>
                          <span title={format(new Date(item.comment.created_at), "PPpp")}>
                            {formatDistanceToNow(new Date(item.comment.created_at), { addSuffix: true })}
                          </span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{item.comment.body}</p>
                      </div>
                    ) : (
                      <div
                        key={item.id}
                        className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground"
                      >
                        <span className="size-1 shrink-0 rounded-full bg-border" />
                        <span className="flex-1">
                          {item.activityEvent.actor_id && (
                            <span className="font-medium text-foreground">
                              {profileName(item.activityEvent.actor_id)}{" "}
                            </span>
                          )}
                          {describeActivity(item.activityEvent)}
                        </span>
                        <span
                          className="shrink-0"
                          title={format(new Date(item.activityEvent.created_at), "PPpp")}
                        >
                          {formatDistanceToNow(new Date(item.activityEvent.created_at), { addSuffix: true })}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </div>
            </div>

            <div className="relative border-t border-border/50 p-3">
              {mentionQuery !== null && mentionMatches.length > 0 && (
                <div className="absolute bottom-full left-3 mb-1 w-56 rounded-lg border border-border bg-popover shadow-md">
                  {mentionMatches.map((p) => (
                    <button
                      key={p.user_id}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertMention(p);
                      }}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-popover-foreground hover:bg-muted"
                    >
                      {p.full_name}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <textarea
                  ref={textareaRef}
                  value={commentBody}
                  onChange={(e) => handleCommentChange(e.target.value)}
                  placeholder={t("commentPlaceholder")}
                  rows={2}
                  disabled={postingComment}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50 disabled:opacity-60"
                />
                <Button
                  size="icon"
                  onClick={() => void handlePostComment()}
                  disabled={postingComment || !commentBody.trim()}
                >
                  {postingComment ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
