"use client";

// Right-side Sheet — the per-channel task list. Same Sheet pattern as
// members-panel.tsx. Open/Completed sections, tick-to-complete (optimistic:
// the caller flips `status` locally before the PATCH resolves and reverts
// on failure — see channel-thread.tsx's `handleToggleTaskStatus`).

import { useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { cn } from "@/lib/utils";
import type { SembangTask } from "@/types";

interface TasksPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tasks: SembangTask[] | null;
  onCreate: (title: string) => Promise<void>;
  onToggleStatus: (task: SembangTask) => void;
  onDelete: (taskId: string) => void;
  creating: boolean;
  deletingId: string | null;
}

export function TasksPanel({
  open,
  onOpenChange,
  tasks,
  onCreate,
  onToggleStatus,
  onDelete,
  creating,
  deletingId,
}: TasksPanelProps) {
  const t = useTranslations("Sembang.tasksPanel");
  const [draft, setDraft] = useState("");

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

  return (
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
}
