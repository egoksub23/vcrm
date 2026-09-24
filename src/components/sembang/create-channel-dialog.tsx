"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Globe2, Lock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { useAccountMembers } from "@/hooks/use-account-members";
import { useAuth } from "@/hooks/use-auth";
import type { SembangChannelSummary } from "@/types";

interface CreateChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (channel: SembangChannelSummary) => void;
}

export function CreateChannelDialog({ open, onOpenChange, onCreated }: CreateChannelDialogProps) {
  const t = useTranslations("Sembang.createDialog");
  const { user } = useAuth();
  const { members } = useAccountMembers();

  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [inviteIds, setInviteIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const invitable = useMemo(
    () => members.filter((m) => m.user_id !== user?.id),
    [members, user?.id],
  );

  const reset = () => {
    setName("");
    setTopic("");
    setIsPrivate(false);
    setInviteIds(new Set());
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const toggleInvite = (userId: string) => {
    setInviteIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleCreate = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/sembang/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          topic: topic.trim() || undefined,
          isPrivate,
          inviteUserIds: isPrivate ? Array.from(inviteIds) : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t("createFailed"));
        return;
      }
      const created = data.channel as { id: string; name: string; topic: string | null; isPrivate: boolean; createdBy: string; createdAt: string };
      onCreated({
        id: created.id,
        name: created.name,
        topic: created.topic,
        isPrivate: created.isPrivate,
        createdBy: created.createdBy,
        createdAt: created.createdAt,
        memberRole: "moderator",
        lastReadAt: created.createdAt,
        unreadCount: 0,
        lastMessageBody: null,
        lastMessageAt: null,
        lastMessageAuthorId: null,
      });
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

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="sembang-channel-name" className="text-xs font-medium text-foreground">
              {t("nameLabel")}
            </label>
            <div className="flex items-center gap-1.5 rounded-lg border border-input bg-transparent pl-2.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
              <span className="text-sm text-muted-foreground" aria-hidden>
                #
              </span>
              <Input
                id="sembang-channel-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("namePlaceholder")}
                maxLength={80}
                className="h-8 border-none pl-0 focus-visible:ring-0"
                autoFocus
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="sembang-channel-topic" className="text-xs font-medium text-foreground">
              {t("topicLabel")}
            </label>
            <Textarea
              id="sembang-channel-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={t("topicPlaceholder")}
              rows={2}
              className="min-h-0"
            />
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">{t("visibilityLabel")}</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setIsPrivate(false)}
                className={cn(
                  "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
                  !isPrivate ? "border-primary bg-primary/5" : "border-border hover:bg-muted",
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Globe2 className="h-4 w-4" aria-hidden />
                  {t("publicTitle")}
                </span>
                <span className="text-xs text-muted-foreground">{t("publicDescription")}</span>
              </button>
              <button
                type="button"
                onClick={() => setIsPrivate(true)}
                className={cn(
                  "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
                  isPrivate ? "border-primary bg-primary/5" : "border-border hover:bg-muted",
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Lock className="h-4 w-4" aria-hidden />
                  {t("privateTitle")}
                </span>
                <span className="text-xs text-muted-foreground">{t("privateDescription")}</span>
              </button>
            </div>
          </div>

          {isPrivate && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">{t("inviteLabel")}</p>
              <ScrollArea className="h-36 rounded-lg border border-border">
                <div className="flex flex-col p-1">
                  {invitable.length === 0 ? (
                    <p className="px-2 py-3 text-xs text-muted-foreground">{t("noOtherMembers")}</p>
                  ) : (
                    invitable.map((m) => (
                      <label
                        key={m.user_id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                      >
                        <Checkbox
                          checked={inviteIds.has(m.user_id)}
                          onCheckedChange={() => toggleInvite(m.user_id)}
                        />
                        <span className="truncate text-foreground">{m.full_name}</span>
                      </label>
                    ))
                  )}
                </div>
              </ScrollArea>
            </div>
          )}

          <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {t.rich("moderatorNote", { strong: (chunks) => <strong className="font-semibold text-foreground">{chunks}</strong> })}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
            {t("cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={!name.trim() || saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
