"use client";

// "New message" dialog — structurally mirrors create-channel-dialog.tsx's
// invite checklist (same "pick people from this account" list) but
// simpler: no name/topic/public-private fields, just a member picker.
// Multi-select allows group DMs (backend caps the group size — see
// POST /api/sembang/dms).

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { useAccountMembers } from "@/hooks/use-account-members";
import { useAuth } from "@/hooks/use-auth";
import type { SembangChannel } from "@/types";

interface NewDmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * POST /api/sembang/dms returns a full `SembangChannel`, not a
   * `SembangChannelSummary` — it has no `dmParticipantNames`/`unreadCount`/
   * etc. (those only come from the sidebar's list RPC). So unlike
   * create-channel-dialog.tsx's `onCreated` (which hands back a ready-to-
   * render summary row), this just hands back the id; page.tsx selects it
   * and refetches the sidebar list to pick up its summary row.
   */
  onCreated: (channelId: string) => void;
}

export function NewDmDialog({ open, onOpenChange, onCreated }: NewDmDialogProps) {
  const t = useTranslations("Sembang.newDmDialog");
  const { user } = useAuth();
  const { members } = useAccountMembers();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const pickable = useMemo(
    () => members.filter((m) => m.user_id !== user?.id),
    [members, user?.id],
  );

  const reset = () => setSelected(new Set());

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const toggle = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleCreate = async () => {
    if (selected.size === 0 || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/sembang/dms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantUserIds: Array.from(selected) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t("createFailed"));
        return;
      }
      const channel = data.channel as SembangChannel | undefined;
      if (!channel) {
        toast.error(t("createFailed"));
        return;
      }
      // Idempotent on the backend — messaging someone you already DM just
      // reopens the existing channel, which is a 200 here, not an error.
      onCreated(channel.id);
      reset();
    } catch {
      toast.error(t("createFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <ScrollArea className="h-56 rounded-lg border border-border">
            <div className="flex flex-col p-1">
              {pickable.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">{t("noOtherMembers")}</p>
              ) : (
                pickable.map((m) => (
                  <label
                    key={m.user_id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                  >
                    <Checkbox checked={selected.has(m.user_id)} onCheckedChange={() => toggle(m.user_id)} />
                    <PersonAvatar name={m.full_name} avatarUrl={m.avatar_url} size="sm" />
                    <span className="truncate text-foreground">{m.full_name}</span>
                  </label>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
            {t("cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={selected.size === 0 || saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
