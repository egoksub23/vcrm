"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { GatedButton, readOnlyTitle } from "@/components/ui/gated-button";
import { useCapability } from "@/hooks/use-can";
import { Loader2, RotateCcw, Trash2, AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { format } from "date-fns";
import { CHANNEL_ICONS } from "./channel-icons";
import type { ChannelType } from "@/types";

interface PendingDeleteRow {
  id: string;
  content_text: string | null;
  channel_type: ChannelType;
  pending_delete_at: string | null;
  conversation_id: string;
  conversation: {
    contact: { name: string | null; phone: string | null; email: string | null } | null;
  } | null;
}

interface PendingDeletePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Lets the trigger button's count badge (conversation-list.tsx)
   *  refresh right after a restore/delete instead of waiting for its
   *  own next poll. */
  onChanged?: () => void;
}

/**
 * Account-wide "Trash" for messages flagged via the per-message "Move
 * to Trash" action (message-actions.tsx) — a message never deletes
 * outright from the thread itself; it lands here first
 * (messages.pending_delete, migration 062) so an agent can review and
 * either restore it or clear it for real.
 */
export function PendingDeletePanel({ open, onOpenChange, onChanged }: PendingDeletePanelProps) {
  const t = useTranslations("Inbox.pendingDelete");
  // Restoring or permanently deleting a message is message deletion: messages.send.
  const canDelete = useCapability("messages.send");
  const [rows, setRows] = useState<PendingDeleteRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [emptyConfirmOpen, setEmptyConfirmOpen] = useState(false);
  const [emptying, setEmptying] = useState(false);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { data, error } = await supabase
      .from("messages")
      .select(
        "id, content_text, channel_type, pending_delete_at, conversation_id, conversation:conversations(contact:contacts(name, phone, email))",
      )
      .eq("pending_delete", true)
      .order("pending_delete_at", { ascending: false });
    if (!error && data) {
      setRows(data as unknown as PendingDeleteRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchRows();
  }, [open, fetchRows]);

  const restore = useCallback(
    async (id: string) => {
      if (!canDelete) return;
      setBusyId(id);
      const supabase = createClient();
      const { error } = await supabase
        .from("messages")
        .update({ pending_delete: false, pending_delete_at: null })
        .eq("id", id);
      if (error) {
        toast.error(t("restoreFailed"));
      } else {
        setRows((prev) => prev.filter((r) => r.id !== id));
        toast.success(t("restored"));
        onChanged?.();
      }
      setBusyId(null);
    },
    [canDelete, onChanged, t],
  );

  const deleteOne = useCallback(
    async (id: string) => {
      if (!canDelete) return;
      setBusyId(id);
      const supabase = createClient();
      const { error } = await supabase.from("messages").delete().eq("id", id);
      if (error) {
        toast.error(t("deleteFailed"));
      } else {
        setRows((prev) => prev.filter((r) => r.id !== id));
        toast.success(t("deleted"));
        onChanged?.();
      }
      setBusyId(null);
    },
    [canDelete, onChanged, t],
  );

  const emptyTrash = useCallback(async () => {
    if (!canDelete) return;
    setEmptying(true);
    const supabase = createClient();
    const { error } = await supabase.from("messages").delete().eq("pending_delete", true);
    if (error) {
      toast.error(t("deleteFailed"));
    } else {
      setRows([]);
      toast.success(t("emptied"));
      onChanged?.();
    }
    setEmptying(false);
    setEmptyConfirmOpen(false);
  }, [canDelete, onChanged, t]);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="bg-popover border-border text-popover-foreground sm:max-w-md w-full p-0 flex flex-col"
        >
          <SheetHeader className="p-4 border-b border-border/50">
            <SheetTitle className="text-popover-foreground">{t("title")}</SheetTitle>
            <SheetDescription className="text-muted-foreground text-xs">
              {t("description")}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-12">{t("empty")}</p>
            ) : (
              rows.map((row) => {
                const Icon = CHANNEL_ICONS[row.channel_type];
                const contact = row.conversation?.contact;
                const name = contact?.name || contact?.email || contact?.phone || t("unknownContact");
                const busy = busyId === row.id;
                return (
                  <div
                    key={row.id}
                    className="rounded-lg border border-border bg-muted/30 p-3"
                  >
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Icon className="size-3 shrink-0" />
                      <span className="font-medium text-foreground truncate">{name}</span>
                      {row.pending_delete_at && (
                        <span className="ml-auto shrink-0">
                          {format(new Date(row.pending_delete_at), "MMM d, HH:mm")}
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm text-foreground line-clamp-2">
                      {row.content_text || t("noPreview")}
                    </p>
                    <div className="mt-2 flex justify-end gap-2">
                      <GatedButton
                        size="sm"
                        variant="outline"
                        canAct={canDelete}
                        gateReason="restore or delete messages"
                        disabled={busy}
                        onClick={() => void restore(row.id)}
                        className="h-7 text-xs"
                      >
                        <RotateCcw className="size-3" />
                        {t("restore")}
                      </GatedButton>
                      <GatedButton
                        size="sm"
                        variant="destructive"
                        canAct={canDelete}
                        gateReason="restore or delete messages"
                        disabled={busy}
                        onClick={() => void deleteOne(row.id)}
                        className="h-7 text-xs"
                      >
                        <Trash2 className="size-3" />
                        {t("deletePermanently")}
                      </GatedButton>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {rows.length > 0 && (
            <div
              className="border-t border-border/50 p-3"
              title={canDelete ? undefined : readOnlyTitle("restore or delete messages")}
            >
              <Button
                variant="destructive"
                className="w-full"
                disabled={!canDelete || emptying}
                onClick={() => setEmptyConfirmOpen(true)}
              >
                {emptying ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                {t("emptyTrash", { count: rows.length })}
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={emptyConfirmOpen} onOpenChange={setEmptyConfirmOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <AlertTriangle className="size-4 text-red-500" />
              {t("emptyConfirmTitle")}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("emptyConfirmDescription", { count: rows.length })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEmptyConfirmOpen(false)} disabled={emptying}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void emptyTrash()} disabled={emptying}>
              {emptying ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("emptyConfirmAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
