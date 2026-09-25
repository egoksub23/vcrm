"use client";

// Right-side Sheet — the per-channel task list. Same Sheet pattern as
// members-panel.tsx. Open/Completed sections, tick-to-complete (optimistic:
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
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { toast } from "sonner";
import { Loader2, Plus, Ticket as TicketIcon, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { CreateTicketDialog } from "@/components/tickets/create-ticket-dialog";
import { useAuth } from "@/hooks/use-auth";
import { useTicketKeyPrefix } from "@/hooks/use-ticket-key-prefix";
import { hasMinRole } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";
import type { SembangTask, Ticket } from "@/types";

interface TasksPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  creating: boolean;
  deletingId: string | null;
}

export function TasksPanel({
  open,
  onOpenChange,
  channelId,
  channelName,
  tasks,
  onCreate,
  onToggleStatus,
  onDelete,
  onTicketLinked,
  creating,
  deletingId,
}: TasksPanelProps) {
  const t = useTranslations("Sembang.tasksPanel");
  const { accountRole } = useAuth();
  const { keyOf } = useTicketKeyPrefix();
  const canCreateTicket = hasMinRole(accountRole ?? "viewer", "agent");
  const [draft, setDraft] = useState("");
  const [ticketTask, setTicketTask] = useState<SembangTask | null>(null);

  const openTasks = (tasks ?? []).filter((task) => task.status === "open");
  const doneTasks = (tasks ?? []).filter((task) => task.status === "done");

  const handleAdd = async () => {
    const trimmed = draft.trim();
    if (!trimmed || creating) return;
    await onCreate(trimmed);
    setDraft("");
  };

  const renderTask = (task: SembangTask) => (
    <div key={task.id} className="group flex items-start gap-2 rounded-lg px-1 py-1.5 hover:bg-muted/40">
      <Checkbox checked={task.status === "done"} onCheckedChange={() => onToggleStatus(task)} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm text-foreground", task.status === "done" && "text-muted-foreground line-through")}>
          {task.title}
        </p>
        {(task.assignee || task.dueAt) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            {task.assignee && (
              <span className="flex items-center gap-1">
                <PersonAvatar name={task.assignee.fullName} avatarUrl={task.assignee.avatarUrl} size="sm" />
                {task.assignee.fullName}
              </span>
            )}
            {task.dueAt && (
              <span className="rounded-full bg-muted px-1.5 py-0.5">{t("due", { date: format(new Date(task.dueAt), "MMM d") })}</span>
            )}
          </div>
        )}
      </div>
      {task.ticketId ? (
        <a
          href={`/tickets?t=${task.ticketId}`}
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
            onClick={() => setTicketTask(task)}
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
        onClick={() => onDelete(task.id)}
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
  };

  const sheet = (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-[420px]">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-2">
          <div className="flex gap-1.5">
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

        <SheetFooter className="border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">{t("footerNote")}</p>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );

  return (
    <>
      {sheet}
      <CreateTicketDialog
        open={!!ticketTask}
        onOpenChange={(next) => {
          if (!next) setTicketTask(null);
        }}
        initialSubject={ticketTask?.title ?? ""}
        initialDescription={t("ticketDescriptionPrefill", { channel: channelName })}
        initialAssigneeId={ticketTask?.assigneeId ?? null}
        onCreated={(ticket) => {
          void handleTicketCreated(ticket);
        }}
      />
    </>
  );
}
