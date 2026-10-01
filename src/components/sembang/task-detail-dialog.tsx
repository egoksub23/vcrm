"use client";

// The Sembang task detail view — a Dialog (not a Sheet), opened from a
// row in tasks-panel.tsx / my-tasks-column.tsx. Self-fetches its own
// `GET .../tasks/[taskId]` on open (the same self-contained-fetch
// convention channel-resources-panel.tsx/thread-panel.tsx already use)
// rather than being piped through channel-thread.tsx's already-large
// state; `onChanged` lets the caller patch its own list-row cache after
// a mutation here, the same one-line shape `handleTicketLinked` already
// uses for the ticket-link flow.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { toast } from "sonner";
import DOMPurify from "dompurify";
import type { Editor } from "@tiptap/react";
import {
  Check,
  Loader2,
  Plus,
  Ticket as TicketIcon,
  Trash2,
  UserPlus,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { AssigneeMenu } from "@/components/tickets/ticket-pickers";
import { MultiSelectPopover, type PickerOption } from "@/components/settings/team/multi-select-popover";
import { RichTextEditor } from "@/components/inbox/rich-text-editor";
import { CreateTicketDialog } from "@/components/tickets/create-ticket-dialog";
import { useAccountMembers } from "@/hooks/use-account-members";
import type {
  SembangTask,
  SembangTaskActivityEvent,
  SembangTaskDetail,
  SembangTaskStatus,
  Ticket,
} from "@/types";

const STATUSES: SembangTaskStatus[] = ["open", "in_progress", "done"];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</p>
      {children}
    </div>
  );
}

interface TaskDetailDialogProps {
  channelId: string;
  channelName: string;
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: (task: SembangTask) => void;
  onDeleted?: () => void;
}

export function TaskDetailDialog({
  channelId,
  channelName,
  taskId,
  open,
  onOpenChange,
  onChanged,
  onDeleted,
}: TaskDetailDialogProps) {
  const t = useTranslations("Sembang.taskDetail");
  const tAct = useTranslations("Sembang.taskDetail.activityLog");
  const router = useRouter();
  const { members, nameOf } = useAccountMembers();

  const [detail, setDetail] = useState<SembangTaskDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [descEditing, setDescEditing] = useState(false);
  const [descDraft, setDescDraft] = useState("");

  const [subtaskDraft, setSubtaskDraft] = useState("");
  const [addingSubtask, setAddingSubtask] = useState(false);

  const [commentHtml, setCommentHtml] = useState("");
  const [commentText, setCommentText] = useState("");
  const [commentMentionIds, setCommentMentionIds] = useState<string[]>([]);
  const [postingComment, setPostingComment] = useState(false);
  const commentEditorRef = useRef<Editor | null>(null);

  // @mention candidates are this task's own channel members, not the
  // whole account (useAccountMembers above is only used for AssigneeMenu).
  const [channelMembers, setChannelMembers] = useState<{ id: string; label: string }[]>([]);

  const [deleting, setDeleting] = useState(false);
  const [ticketDialogOpen, setTicketDialogOpen] = useState(false);

  const base = `/api/sembang/channels/${channelId}/tasks/${taskId}`;

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(base, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setDetail(data as SembangTaskDetail);
    } catch {
      toast.error(t("loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, taskId]);

  useEffect(() => {
    if (!open) return;
    (async () => {
      const res = await fetch(`/api/sembang/channels/${channelId}/members`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { members?: { userId: string; fullName: string }[] };
      if (!res.ok || !data.members) return;
      setChannelMembers(
        data.members.filter((m) => m.fullName).map((m) => ({ id: m.userId, label: m.fullName })),
      );
    })();
  }, [open, channelId]);

  const patch = async (body: Record<string, unknown>) => {
    const res = await fetch(base, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data?.error || t("updateFailed"));
      return null;
    }
    const task = data.task as SembangTask;
    setDetail((prev) => (prev ? { ...prev, task } : prev));
    onChanged?.(task);
    return task;
  };

  const task = detail?.task ?? null;

  const saveTitle = async () => {
    setTitleEditing(false);
    if (!task || titleDraft.trim() === task.title || !titleDraft.trim()) return;
    await patch({ title: titleDraft.trim() });
  };

  const saveDescription = async () => {
    setDescEditing(false);
    if (!task || descDraft === (task.description ?? "")) return;
    await patch({ description: descDraft || null });
  };

  const toggleAssignee = async (userId: string, assigned: boolean) => {
    if (!task) return;
    const res = await fetch(
      assigned ? `${base}/assignees` : `${base}/assignees/${userId}`,
      assigned
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }) }
        : { method: "DELETE" },
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data?.error || t("assigneeUpdateFailed"));
    }
    await load();
    if (detail) onChanged?.(detail.task);
  };

  const addSubtask = async () => {
    const title = subtaskDraft.trim();
    if (!title || addingSubtask) return;
    setAddingSubtask(true);
    try {
      const res = await fetch(`${base}/subtasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t("subtaskAddFailed"));
        return;
      }
      setDetail((prev) => (prev ? { ...prev, subtasks: [...prev.subtasks, data.subtask] } : prev));
      setSubtaskDraft("");
      await load();
    } finally {
      setAddingSubtask(false);
    }
  };

  const toggleSubtask = async (subtaskId: string, nextStatus: "open" | "done") => {
    const res = await fetch(`${base}/subtasks/${subtaskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data?.error || t("updateFailed"));
      return;
    }
    setDetail((prev) =>
      prev ? { ...prev, subtasks: prev.subtasks.map((s) => (s.id === subtaskId ? data.subtask : s)) } : prev,
    );
    await load();
  };

  const setSubtaskAssignee = async (subtaskId: string, assigneeId: string | null) => {
    const res = await fetch(`${base}/subtasks/${subtaskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data?.error || t("updateFailed"));
      return;
    }
    setDetail((prev) =>
      prev ? { ...prev, subtasks: prev.subtasks.map((s) => (s.id === subtaskId ? data.subtask : s)) } : prev,
    );
  };

  const deleteSubtask = async (subtaskId: string) => {
    const res = await fetch(`${base}/subtasks/${subtaskId}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data?.error || t("subtaskDeleteFailed"));
      return;
    }
    setDetail((prev) => (prev ? { ...prev, subtasks: prev.subtasks.filter((s) => s.id !== subtaskId) } : prev));
    await load();
  };

  const postComment = async () => {
    const text = commentText.trim();
    if (!text || postingComment) return;
    setPostingComment(true);
    try {
      const res = await fetch(`${base}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: commentHtml, mentions: commentMentionIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t("commentFailed"));
        return;
      }
      setCommentHtml("");
      setCommentText("");
      setCommentMentionIds([]);
      commentEditorRef.current?.commands.clearContent();
      await load();
    } finally {
      setPostingComment(false);
    }
  };

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(base, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t("deleteFailed"));
        return;
      }
      onDeleted?.();
      onOpenChange(false);
    } finally {
      setDeleting(false);
    }
  };

  const handleTicketCreated = async (ticket: Ticket) => {
    const updated = await patch({ ticketId: ticket.id });
    if (updated) router.push(`/tickets?t=${ticket.id}`);
  };

  const assigneeOptions: PickerOption[] = members.map((m) => ({ id: m.user_id, label: m.full_name }));
  const assignedIds = task?.assignees.map((a) => a.id) ?? [];

  const describeEvent = (a: SembangTaskActivityEvent): string => {
    const statusLabel = (v: string | null) =>
      v === "open" ? t("statusOpen") : v === "in_progress" ? t("statusInProgress") : v === "done" ? t("statusDone") : v ?? "";
    switch (a.eventType) {
      case "created":
        return tAct("created");
      case "status_changed":
        return tAct("statusChanged", { from: statusLabel(a.fromValue), to: statusLabel(a.toValue) });
      case "title_changed":
        return tAct("titleChanged");
      case "description_changed":
        return tAct("descriptionChanged");
      case "due_changed":
        return a.toValue ? tAct("dueChanged", { date: format(new Date(a.toValue), "MMM d") }) : tAct("dueCleared");
      case "assignee_added":
        return tAct("assigneeAdded", { name: nameOf(a.toValue, t("unknownPerson")) });
      case "assignee_removed":
        return tAct("assigneeRemoved", { name: nameOf(a.fromValue, t("unknownPerson")) });
      case "subtask_added":
        return tAct("subtaskAdded", { title: a.toValue ?? "" });
      case "subtask_completed":
        return tAct("subtaskCompleted", { title: a.toValue ?? "" });
      case "subtask_reopened":
        return tAct("subtaskReopened", { title: a.toValue ?? "" });
      case "subtask_deleted":
        return tAct("subtaskDeleted", { title: a.fromValue ?? "" });
      case "ticket_linked":
        return tAct("ticketLinked");
      default:
        return a.eventType;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] w-full max-w-[1100px] flex-col gap-0 overflow-hidden border-border bg-popover p-0 text-popover-foreground sm:max-w-[1100px] max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none">
        <DialogTitle className="sr-only">{t("dialogTitle")}</DialogTitle>
        <DialogDescription className="sr-only">{t("dialogDescription")}</DialogDescription>

        {loading && !detail ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : !detail || !task ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-muted-foreground">{t("loadFailed")}</p>
          </div>
        ) : (
          <div className="grid flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[1fr_360px]">
            {/* Left column */}
            <div className="flex flex-col overflow-y-auto border-border p-5 lg:border-r">
              {titleEditing ? (
                <Input
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveTitle();
                    } else if (e.key === "Escape") {
                      setTitleEditing(false);
                    }
                  }}
                  className="mb-4 h-9 text-lg font-heading font-semibold"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setTitleDraft(task.title);
                    setTitleEditing(true);
                  }}
                  className="mb-4 -mx-1.5 rounded-md px-1.5 py-1 text-left font-heading text-lg font-semibold text-foreground hover:bg-muted/70"
                >
                  {task.title}
                </button>
              )}

              <div className="grid grid-cols-2 gap-4">
                <Field label={t("fieldStatus")}>
                  <Select
                    value={task.status}
                    onValueChange={(v) => void patch({ status: v as SembangTaskStatus })}
                  >
                    <SelectTrigger className="h-8 w-full bg-muted text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s === "open" ? t("statusOpen") : s === "in_progress" ? t("statusInProgress") : t("statusDone")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t("fieldDueDate")}>
                  <Input
                    type="date"
                    value={task.dueAt ? task.dueAt.slice(0, 10) : ""}
                    onChange={(e) =>
                      void patch({ dueAt: e.target.value ? new Date(e.target.value).toISOString() : null })
                    }
                    className="h-8 w-full text-xs"
                  />
                </Field>
              </div>

              <div className="mt-4">
                <Field label={t("fieldAssignees")}>
                  <MultiSelectPopover
                    options={assigneeOptions}
                    selected={assignedIds}
                    onChange={(nextIds) => {
                      const added = nextIds.filter((id) => !assignedIds.includes(id));
                      const removed = assignedIds.filter((id) => !nextIds.includes(id));
                      for (const id of added) void toggleAssignee(id, true);
                      for (const id of removed) void toggleAssignee(id, false);
                    }}
                    label={
                      assignedIds.length === 0
                        ? t("unassigned")
                        : t("assigneeCount", { count: assignedIds.length })
                    }
                    icon={<UserPlus className="size-3.5" />}
                    emptyLabel={t("noMembers")}
                    className="h-8 w-full text-xs"
                  />
                  {task.assignees.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {task.assignees.map((a) => (
                        <span
                          key={a.id}
                          className="flex items-center gap-1 rounded-full bg-muted py-0.5 pr-2 pl-0.5 text-[11px] text-foreground"
                        >
                          <PersonAvatar name={a.fullName} avatarUrl={a.avatarUrl} size="sm" />
                          {a.fullName}
                        </span>
                      ))}
                    </div>
                  )}
                </Field>
              </div>

              <div className="mt-5">
                <p className="mb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {t("fieldDescription")}
                </p>
                {descEditing ? (
                  <div className="space-y-2">
                    <textarea
                      autoFocus
                      value={descDraft}
                      onChange={(e) => setDescDraft(e.target.value)}
                      rows={5}
                      className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-primary/50"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault();
                          void saveDescription();
                        } else if (e.key === "Escape") {
                          e.stopPropagation();
                          setDescEditing(false);
                        }
                      }}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => void saveDescription()}>
                        {t("save")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDescEditing(false)}>
                        {t("cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setDescDraft(task.description ?? "");
                      setDescEditing(true);
                    }}
                    className="-mx-2 block w-[calc(100%+1rem)] cursor-text rounded-md px-2 py-1.5 text-left text-[13px] leading-relaxed whitespace-pre-wrap hover:bg-muted/70"
                  >
                    {task.description || <span className="text-muted-foreground">{t("descriptionPlaceholder")}</span>}
                  </button>
                )}
              </div>

              <div className="mt-5">
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {t("fieldSubtasks")}
                  </p>
                  <span className="text-[10.5px] text-muted-foreground">
                    {task.subtaskDoneCount}/{task.subtaskCount}
                  </span>
                </div>
                <div className="space-y-1">
                  {detail.subtasks.map((s) => (
                    <div key={s.id} className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/40">
                      <Checkbox
                        checked={s.status === "done"}
                        onCheckedChange={() => void toggleSubtask(s.id, s.status === "done" ? "open" : "done")}
                      />
                      <span
                        className={`min-w-0 flex-1 truncate text-[13px] ${s.status === "done" ? "text-muted-foreground line-through" : "text-foreground"}`}
                      >
                        {s.title}
                      </span>
                      <AssigneeMenu
                        assigneeId={s.assigneeId}
                        members={members}
                        onChange={(userId) => void setSubtaskAssignee(s.id, userId)}
                        withName={false}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("removeSubtask")}
                        onClick={() => void deleteSubtask(s.id)}
                        className="opacity-0 group-hover:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="mt-1.5 flex gap-1.5">
                  <Input
                    value={subtaskDraft}
                    onChange={(e) => setSubtaskDraft(e.target.value)}
                    placeholder={t("addSubtaskPlaceholder")}
                    className="h-8 text-xs"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void addSubtask();
                      }
                    }}
                  />
                  <Button size="icon" className="h-8 w-8 shrink-0" onClick={() => void addSubtask()} disabled={!subtaskDraft.trim() || addingSubtask}>
                    {addingSubtask ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
                {task.ticketId ? (
                  <a
                    href={`/tickets?t=${task.ticketId}`}
                    className="flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                  >
                    <TicketIcon className="h-4 w-4" />
                    {t("viewTicket", { number: task.ticketNumber ?? "" })}
                  </a>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setTicketDialogOpen(true)}>
                    <TicketIcon className="h-3.5 w-3.5" />
                    {t("createTicket")}
                  </Button>
                )}
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void handleDelete()} disabled={deleting}>
                  {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  {t("deleteTask")}
                </Button>
              </div>
            </div>

            {/* Right column — activity + comments */}
            <div className="flex flex-col overflow-hidden">
              <div className="shrink-0 border-b border-border px-4 py-3">
                <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("activity")}</p>
              </div>
              <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
                {detail.activity.map((a) => (
                  <p key={a.id} className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{a.actorName || t("unknownPerson")}</span>{" "}
                    {describeEvent(a)}
                    <span className="ml-1.5 text-[10.5px]">{format(new Date(a.createdAt), "MMM d, HH:mm")}</span>
                  </p>
                ))}
                {detail.comments.map((c) => (
                  <div key={c.id} className="flex items-start gap-2">
                    <PersonAvatar name={c.authorName} avatarUrl={c.authorAvatarUrl} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-xs font-semibold text-foreground">{c.authorName || t("unknownPerson")}</span>
                        <span className="text-[10.5px] text-muted-foreground">{format(new Date(c.createdAt), "MMM d, HH:mm")}</span>
                      </div>
                      <div
                        className="rte-content text-[13px] text-foreground"
                        // Same-account authored rich text, rendered inline
                        // (not iframe-sandboxed like inbound email) —
                        // DOMPurify here is defense-in-depth, matching
                        // email-html-view.tsx's own justification.
                        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(c.body) }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="shrink-0 border-t border-border p-3">
                <RichTextEditor
                  onChangeHtml={(html, text) => {
                    setCommentHtml(html);
                    setCommentText(text);
                  }}
                  onEditorReady={(editor) => {
                    commentEditorRef.current = editor;
                  }}
                  placeholder={t("commentPlaceholder")}
                  mentions={{
                    candidates: channelMembers,
                    onMentionsChange: setCommentMentionIds,
                  }}
                />
                <div className="mt-2 flex justify-end">
                  <Button size="sm" onClick={() => void postComment()} disabled={!commentText.trim() || postingComment}>
                    {postingComment ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    {t("comment")}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>

      <CreateTicketDialog
        open={ticketDialogOpen}
        onOpenChange={setTicketDialogOpen}
        initialSubject={task?.title ?? ""}
        initialDescription={t("ticketDescriptionPrefill", { channel: channelName })}
        initialAssigneeId={task?.assignees[0]?.id ?? null}
        onCreated={(ticket) => {
          void handleTicketCreated(ticket);
        }}
      />
    </Dialog>
  );
}
