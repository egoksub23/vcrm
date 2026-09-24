"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Crown, Loader2, Plus, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { PresenceDot } from "@/components/presence/presence-dot";
import { presenceLabel } from "@/lib/presence";
import { usePresence } from "@/hooks/use-presence";
import { useAccountMembers } from "@/hooks/use-account-members";
import { useAuth } from "@/hooks/use-auth";
import type { SembangMember } from "@/types";

interface MembersPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  isPrivate: boolean;
  canManage: boolean;
  members: SembangMember[] | null;
  onMembersChange: (members: SembangMember[]) => void;
}

export function MembersPanel({
  open,
  onOpenChange,
  channelId,
  isPrivate,
  canManage,
  members,
  onMembersChange,
}: MembersPanelProps) {
  const t = useTranslations("Sembang.membersPanel");
  const { user } = useAuth();
  const { getPresence, now, getRow } = usePresence();
  const { members: accountMembers } = useAccountMembers();

  const [adding, setAdding] = useState(false);
  const [addSelection, setAddSelection] = useState<Set<string>>(new Set());
  const [savingAdd, setSavingAdd] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setAdding(false);
      setAddSelection(new Set());
    }
  }, [open]);

  const memberIds = useMemo(() => new Set((members ?? []).map((m) => m.userId)), [members]);
  const invitable = useMemo(
    () => accountMembers.filter((m) => !memberIds.has(m.user_id)),
    [accountMembers, memberIds],
  );

  const moderators = (members ?? []).filter((m) => m.role === "moderator");
  const plainMembers = (members ?? []).filter((m) => m.role === "member");

  const toggleAddSelection = (userId: string) => {
    setAddSelection((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleAddPeople = async () => {
    if (addSelection.size === 0 || savingAdd) return;
    setSavingAdd(true);
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: Array.from(addSelection) }),
      });
      // The route reports per-user success/failure in the body and can
      // return 200 OR 207 (partial) — both are `res.ok` (207 is a 2xx
      // status) — so a batch that failed for everyone still needs its
      // own check rather than trusting the HTTP status alone.
      const data = (await res.json().catch(() => ({}))) as {
        added?: string[];
        failed?: { userId: string; error: string }[];
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error || t("addFailed"));
        return;
      }
      if (data.failed && data.failed.length > 0) {
        toast.error(
          data.added && data.added.length > 0
            ? t("addPartialFailed", { count: data.failed.length })
            : data.failed[0]?.error || t("addFailed"),
        );
      }
      // Refetch the member list rather than trust the response shape for
      // rendering — a fresh GET (with the profiles join) is unambiguous.
      const refreshed = await fetch(`/api/sembang/channels/${channelId}/members`, { cache: "no-store" });
      const refreshedData = await refreshed.json().catch(() => ({}));
      if (refreshed.ok && Array.isArray(refreshedData.members)) {
        onMembersChange(refreshedData.members as SembangMember[]);
      }
      setAdding(false);
      setAddSelection(new Set());
    } catch {
      toast.error(t("addFailed"));
    } finally {
      setSavingAdd(false);
    }
  };

  const handleRemove = async (userId: string) => {
    if (removingId) return;
    setRemovingId(userId);
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}/members/${userId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error || t("removeFailed"));
        return;
      }
      onMembersChange((members ?? []).filter((m) => m.userId !== userId));
    } catch {
      toast.error(t("removeFailed"));
    } finally {
      setRemovingId(null);
    }
  };

  const renderRow = (m: SembangMember) => {
    const isYou = m.userId === user?.id;
    const row = getRow(m.userId);
    return (
      <div key={m.userId} className="flex items-center gap-2.5 px-1 py-1.5">
        <div className="relative shrink-0">
          <PersonAvatar name={m.fullName} avatarUrl={m.avatarUrl} size="md" />
          <PresenceDot
            status={getPresence(m.userId)}
            label={presenceLabel(getPresence(m.userId), row?.last_seen_at, now)}
            className="absolute -right-0.5 -bottom-0.5 ring-2 ring-card"
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-foreground">
            {m.fullName}
            {isYou && <span className="ml-1 text-xs text-muted-foreground">{t("youTag")}</span>}
          </p>
        </div>
        {canManage && !isYou && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("removeAriaLabel", { name: m.fullName })}
            onClick={() => handleRemove(m.userId)}
            disabled={removingId === m.userId}
          >
            {removingId === m.userId ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <UserMinus className="h-3.5 w-3.5" />
            )}
          </Button>
        )}
      </div>
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-[380px]">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
          {members === null ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : (
            <>
              {moderators.length > 0 && (
                <div>
                  <p className="mb-1 flex items-center gap-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    <Crown className="h-3 w-3" aria-hidden />
                    {t("moderatorsSection", { count: moderators.length })}
                  </p>
                  <div>{moderators.map(renderRow)}</div>
                </div>
              )}
              <div>
                <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {t("membersSection", { count: plainMembers.length })}
                </p>
                {plainMembers.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">{t("noOtherMembers")}</p>
                ) : (
                  <div>{plainMembers.map(renderRow)}</div>
                )}
              </div>
            </>
          )}

          {canManage && (
            <div className="border-t border-border pt-3">
              {!adding ? (
                <Button variant="outline" size="sm" onClick={() => setAdding(true)} className="w-full">
                  <Plus className="h-4 w-4" />
                  {t("addPeople")}
                </Button>
              ) : (
                <div className="space-y-2">
                  <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1">
                    {invitable.length === 0 ? (
                      <p className="px-2 py-2 text-xs text-muted-foreground">{t("noOtherMembers")}</p>
                    ) : (
                      invitable.map((m) => (
                        <label
                          key={m.user_id}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                        >
                          <Checkbox
                            checked={addSelection.has(m.user_id)}
                            onCheckedChange={() => toggleAddSelection(m.user_id)}
                          />
                          <span className="truncate text-foreground">{m.full_name}</span>
                        </label>
                      ))
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => {
                        setAdding(false);
                        setAddSelection(new Set());
                      }}
                    >
                      {t("cancel")}
                    </Button>
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={handleAddPeople}
                      disabled={addSelection.size === 0 || savingAdd}
                    >
                      {savingAdd && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {t("addSelected", { count: addSelection.size })}
                    </Button>
                  </div>
                </div>
              )}
              {isPrivate && <p className="mt-2 text-xs text-muted-foreground">{t("privateAddCaption")}</p>}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
