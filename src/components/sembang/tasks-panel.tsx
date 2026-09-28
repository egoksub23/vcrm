"use client";

// The channel's Tasks tab (Slack-style persistent tab, not a sliding
// Sheet). Open/Completed sections, tick-to-complete (optimistic:
// the caller flips `status` locally before the PATCH resolves and reverts
// on failure — see channel-thread.tsx's `handleToggleTaskStatus`).
//
// Migration 103 — "Create Ticket" per task: reuses CreateTicketDialog
// as-is (prefilled with the task's title/assignee via its initial*
// props) rather than building a second ticket-creation form. Gated on
// role >= agent (the same role the `tickets_insert` RLS policy itself
// requires) so the button doesn't invite a failed insert. Once a task
// has a linked ticket the button becomes "View <KEY>" instead — the
// link is write-once (sembang_tasks_guard()), so this UI never needs to
// handle "already linked, try to link again."

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { toast } from "sonner";
import { Loader2, Plus, Ticket as TicketIcon, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { CreateTicketDialog } from "@/components/tickets/create-ticket-dialog";
import { TaskDetailDialog } from "./task-detail-dialog";
import { useAuth } from "@/hooks/use-auth";
import { useTicketKeyPrefix } from "@/hooks/use-ticket-key-prefix";
import { hasMinRole } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";
import type { SembangTask, Ticket } from "@/types";

interface TasksTabBodyProps {
  /** Needed to PATCH the task's ticket_id after a ticket is created —
   *  the task rows themselves don't carry their own channel id. */
  channelId: string;
  channelName: string;
  tasks: SembangTask[] | null;
  onCreate: (title: string) => Promise<void>;
  onToggleStatus: (task: SembangTask) => void;
  onDelete: (taskId: string) => void;
  /** Fired after a ticket is created from a task and the link is saved,
   *  so the caller can patch its own local `tasks` state (same
   *  optimistic-local-patch convention every other task mutation here
   *  already follows). */
  onTicketLinked: (taskId: string, ticketId: string, ticketNumber: number) => void;
  /** Fired by TaskDetailDialog after any field change (status, title,
   *  description, due date — assignees/subtasks are reflected via a
   *  full detail refetch inside the dialog itself) so the row list
   *  reflects it without waiting for a realtime refetch. */
  onTaskUpdated: (task: SembangTask) => void;
  creating: boolean;
  deletingId: string | null;
}

export function TasksTabBody({
  channelId,
  channelName,
  tasks,
  onCreate,
  onToggleStatus,
  onDelete,
  onTicketLinked,
  onTaskUpdated,
  creating,
  deletingId,
}: TasksTabBodyProps) {
  const t = useTranslations("Sembang.tasksPanel");
  const router = useRouter();
  const { accountRole } = useAuth();
  const { keyOf } = useTicketKeyPrefix();
  const canCreateTicket = hasMinRole(accountRole ?? "viewer", "agent");
  const [draft, setDraft] = useState("");
  const [ticketTask, setTicketTask] = useState<SembangTask | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);

  const openTasks = (tasks ?? []).filter((task) => task.status !== "done");
  const doneTasks = (tasks ?? []).filter((task) => task.status === "done");

  const handleAdd = async () => {
    const trimmed = draft.trim();
    if (!trimmed || creating) return;
    await onCreate(trimmed);
    setDraft("");
  };

  const renderTask = (task: SembangTask) => (
    <div
      key={task.id}
      role="button"
      tabIndex={0}
      onClick={() => setDetailTaskId(task.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") setDetailTaskId(task.id);
      }}
      className="group flex cursor-pointer items-start gap-2 rounded-lg px-1 py-1.5 hover:bg-muted/40"
    >
      <Checkbox
        checked={task.status === "done"}
        onCheckedChange={() => onToggleStatus(task)}
        onClick={(e) => e.stopPropagation()}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className={cn("text-sm text-foreground", task.status === "done" && "text-muted-foreground line-through")}>
            {task.title}
          </p>
          {task.status === "in_progress" && (
            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {t("statusInProgress")}
            </span>
          )}
        </div>
        {(task.assignees.length > 0 || task.dueAt || task.subtaskCount > 0) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            {task.assignees.length > 0 && (
              <span className="flex items-center -space-x-1">
                {task.assignees.slice(0, 3).map((a) => (
                  <PersonAvatar key={a.id} name={a.fullName} avatarUrl={a.avatarUrl} size="sm" className="ring-2 ring-background" />
                ))}
                {task.assignees.length > 3 && <span className="ml-1.5">+{task.assignees.length - 3}</span>}
              </span>
            )}
            {task.dueAt && (
              <span className="rounded-full bg-muted px-1.5 py-0.5">{t("due", { date: format(new Date(task.dueAt), "MMM d") })}</span>
            )}
            {task.subtaskCount > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5">{task.subtaskDoneCount}/{task.subtaskCount}</span>
            )}
          </div>
        )}
      </div>
      {task.ticketId ? (
        <a
          href={`/tickets?t=${task.ticketId}`}
          onClick={(e) => e.stopPropagation()}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-primary opacity-0 group-hover:opacity-100 hover:bg-primary/10"
        >
          <TicketIcon className="h-3 w-3" aria-hidden />
          {task.ticketNumber != null ? keyOf(task.ticketNumber) : t("viewTicket")}
        </a>
      ) : (
        canCreateTicket && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("createTicket")}
            title={t("createTicket")}
            onClick={(e) => {
              e.stopPropagation();
              setTicketTask(task);
            }}
            className="opacity-0 group-hover:opacity-100"
          >
            <TicketIcon className="h-3.5 w-3.5" />
          </Button>
        )
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("deleteTask")}
        title={t("deleteTask")}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(task.id);
        }}
        disabled={deletingId === task.id}
        className="opacity-0 group-hover:opacity-100"
      >
        {deletingId === task.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );

  const handleTicketCreated = async (ticket: Ticket) => {
    if (!ticketTask) return;
    const task = ticketTask;
    const res = await fetch(`/api/sembang/channels/${channelId}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId: ticket.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data?.error || t("linkTicketFailed"));
      return;
    }
    onTicketLinked(task.id, ticket.id, ticket.ticket_number);
    router.push(`/tickets?t=${ticket.id}`);
  };

  const body = (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 gap-1.5 border-b border-border px-3 py-3 sm:px-4">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("addPlaceholder")}
          aria-label={t("addPlaceholder")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleAdd();
            }
          }}
        />
        <Button size="icon" onClick={handleAdd} disabled={!draft.trim() || creating} aria-label={t("addTask")}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-3 sm:px-4">
        {tasks === null ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : (
          <>
            <div>
              <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {t("openSection", { count: openTasks.length })}
              </p>
              {openTasks.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">{t("noOpenTasks")}</p>
              ) : (
                openTasks.map(renderTask)
              )}
            </div>
            {doneTasks.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {t("doneSection", { count: doneTasks.length })}
                </p>
                {doneTasks.map(renderTask)}
              </div>
            )}
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3 py-2.5 sm:px-4">
        <p className="text-xs text-muted-foreground">{t("footerNote")}</p>
      </div>
    </div>
  );

  return (
    <>
      {body}
      <CreateTicketDialog
        open={!!ticketTask}
        onOpenChange={(next) => {
          if (!next) setTicketTask(null);
        }}
        initialSubject={ticketTask?.title ?? ""}
        initialDescription={t("ticketDescriptionPrefill", { channel: channelName })}
        initialAssigneeId={ticketTask?.assignees[0]?.id ?? null}
        onCreated={(ticket) => {
          void handleTicketCreated(ticket);
        }}
      />
      {detailTaskId && (
        <TaskDetailDialog
          open
          onOpenChange={(next) => {
            if (!next) setDetailTaskId(null);
          }}
          channelId={channelId}
          channelName={channelName}
          taskId={detailTaskId}
          onChanged={onTaskUpdated}
          onDeleted={() => {
            onDelete(detailTaskId);
            setDetailTaskId(null);
          }}
        />
      )}
    </>
  );
}
