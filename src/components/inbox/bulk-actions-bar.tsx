"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Lock, Mail, MailOpen, UserPlus, UserX } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import {
  bulkAssign,
  bulkClose,
  bulkMarkRead,
  bulkMarkUnread,
  type BulkResult,
} from "@/lib/inbox/bulk-actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CloseConversationDialog } from "./close-conversation-dialog";
import type { Conversation, Profile } from "@/types";

interface BulkActionsBarProps {
  selected: Conversation[];
  visibleCount: number;
  onSelectAll: () => void;
  onClear: () => void;
  /** Local-state patch for the conversations a bulk write succeeded on. */
  onPatch: (ids: string[], patch: Partial<Conversation>) => void;
  /** Leave multi-select mode (after an action completes). */
  onDone: () => void;
  /** The existing "Apply label" control, owned by ConversationList. */
  labelControl: ReactNode;
}

/**
 * Floating action bar for the inbox's multi-select mode: Assign to…,
 * Apply label, Mark read/unread, Close. The label action predates this and
 * is passed in; the rest run through `lib/inbox/bulk-actions`, which reuses
 * the single-conversation write paths so audit + notifications match.
 */
export function BulkActionsBar({
  selected,
  visibleCount,
  onSelectAll,
  onClear,
  onPatch,
  onDone,
  labelControl,
}: BulkActionsBarProps) {
  const t = useTranslations("Inbox.conversationList.bulk");
  const tList = useTranslations("Inbox.conversationList");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [busy, setBusy] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    createClient()
      .from("profiles")
      .select("*")
      .order("full_name")
      .then(({ data }) => {
        if (!cancelled) setProfiles((data as Profile[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ids = selected.map((c) => c.id);

  const finish = (
    result: BulkResult,
    patch: Partial<Conversation>,
    successMessage: string,
  ) => {
    if (result.succeeded.length > 0) onPatch(result.succeeded, patch);
    if (result.failed > 0) {
      toast.error(t("partialFailure", { succeeded: result.succeeded.length, total: result.succeeded.length + result.failed }));
    } else if (result.succeeded.length === 0) {
      toast.message(t("nothingToDo"));
    } else {
      toast.success(successMessage);
    }
    if (result.failed === 0) onDone();
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const handleAssign = (agent: Profile | null) =>
    run(async () => {
      const res = await bulkAssign(createClient(), ids, agent?.user_id ?? null);
      finish(
        res,
        { assigned_agent_id: agent?.user_id },
        agent
          ? t("assigned", { count: res.succeeded.length, name: agent.full_name })
          : t("unassigned", { count: res.succeeded.length }),
      );
    });

  const handleRead = (read: boolean) =>
    run(async () => {
      const db = createClient();
      const res = read ? await bulkMarkRead(db, selected) : await bulkMarkUnread(db, selected);
      finish(
        res,
        { unread_count: read ? 0 : 1 },
        t(read ? "markedRead" : "markedUnread", { count: res.succeeded.length }),
      );
    });

  const handleClose = (note: string) =>
    run(async () => {
      const res = await bulkClose(createClient(), selected, note);
      setCloseOpen(false);
      finish(
        res,
        { status: "closed", closed_at: new Date().toISOString() },
        t("closed", { count: res.succeeded.length }),
      );
    });

  const iconBtn =
    "inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs text-foreground hover:bg-muted disabled:opacity-50";

  return (
    <div className="shrink-0 space-y-2 border-b border-border bg-muted/50 px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium text-foreground">
          {tList("selectedCount", { count: selected.length })}
        </span>
        {selected.length < visibleCount && (
          <button type="button" onClick={onSelectAll} className="text-primary hover:underline">
            {t("selectAll", { count: visibleCount })}
          </button>
        )}
        <button
          type="button"
          onClick={onClear}
          className="ml-auto rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {tList("clearAll")}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger disabled={busy} className={iconBtn} title={t("assign")}>
            <UserPlus className="h-3.5 w-3.5" />
            {t("assign")}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-64 w-56 border-border bg-popover">
            {profiles.map((p) => (
              <DropdownMenuItem
                key={p.user_id}
                onClick={() => void handleAssign(p)}
                className="text-sm text-popover-foreground"
              >
                <span className="truncate">{p.full_name}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              onClick={() => void handleAssign(null)}
              className="text-sm text-muted-foreground"
            >
              <UserX className="mr-2 h-3.5 w-3.5" />
              {t("unassign")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {labelControl}

        <button type="button" disabled={busy} onClick={() => void handleRead(true)} className={iconBtn} title={t("markRead")}>
          <MailOpen className="h-3.5 w-3.5" />
        </button>
        <button type="button" disabled={busy} onClick={() => void handleRead(false)} className={iconBtn} title={t("markUnread")}>
          <Mail className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setCloseOpen(true)}
          className={`${iconBtn} ml-auto text-destructive`}
          title={t("close")}
        >
          <Lock className="h-3.5 w-3.5" />
          {t("close")}
        </button>
      </div>

      <CloseConversationDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        onConfirm={(note) => void handleClose(note)}
        busy={busy}
        count={selected.length}
      />
    </div>
  );
}
