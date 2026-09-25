"use client";

// Right-side Sheet listing the caller's own unread @mentions and DM
// messages across every channel/DM — same Sheet structure as
// starred-panel.tsx (the closest existing analog), sourced from
// GET /api/sembang/mentions. "Mark as done" writes notifications.read_at
// directly via the Supabase client, the exact mechanism the Notifications
// page already uses (see src/app/(dashboard)/notifications/page.tsx) —
// reused here rather than adding a new API route for it.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { Check, Loader2 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { useAccountMembers } from "@/hooks/use-account-members";
import { createClient } from "@/lib/supabase/client";
import { MessageBody } from "./message-body";
import type { SembangMentionItem } from "@/types";

interface MentionsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Bumped by the caller whenever a mention is cleared, so the header
   *  badge count (a separate fetch over the channel list) can refresh. */
  onCleared?: () => void;
}

export function MentionsPanel({ open, onOpenChange, onCleared }: MentionsPanelProps) {
  const t = useTranslations("Sembang.mentionsPanel");
  const router = useRouter();
  const { members: accountMembers } = useAccountMembers();
  const peopleNames = useMemo(() => accountMembers.map((m) => m.full_name), [accountMembers]);

  const [results, setResults] = useState<SembangMentionItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [clearingId, setClearingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const res = await fetch("/api/sembang/mentions", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        if (!cancelled) setResults((data.results as SembangMentionItem[]) ?? []);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSelect = (channelId: string) => {
    router.push(`/sembang?c=${channelId}`);
    onOpenChange(false);
  };

  const handleClear = async (notificationId: string) => {
    setClearingId(notificationId);
    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", notificationId);
    setClearingId(null);
    if (updateError) return;
    setResults((prev) => prev?.filter((r) => r.notificationId !== notificationId) ?? prev);
    onCleared?.();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-[420px]">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : error ? (
            <p className="py-8 text-center text-sm text-destructive">{t("loadFailed")}</p>
          ) : !results || results.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            results.map((r) => (
              <div
                key={r.notificationId}
                className="rounded-lg border border-border p-2.5 hover:bg-muted/40"
              >
                <button
                  type="button"
                  onClick={() => handleSelect(r.channel.id)}
                  className="block w-full text-left"
                >
                  {r.message ? (
                    <div className="flex items-start gap-2">
                      <PersonAvatar
                        name={r.message.author?.fullName}
                        avatarUrl={r.message.author?.avatarUrl}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          <span className="truncate text-xs font-semibold text-foreground">
                            {r.message.author?.fullName ?? t("unknownAuthor")}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {format(new Date(r.message.createdAt), "MMM d, HH:mm")}
                          </span>
                        </div>
                        <MessageBody body={r.message.body} peopleNames={peopleNames} />
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("messageRemoved")}</p>
                  )}
                  <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
                    {r.channel.isDm
                      ? r.channel.dmParticipantNames?.join(", ") || t("directMessage")
                      : `#${r.channel.name ?? ""}`}
                  </p>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-1.5 h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
                  disabled={clearingId === r.notificationId}
                  onClick={() => handleClear(r.notificationId)}
                >
                  {clearingId === r.notificationId ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                  {t("markDone")}
                </Button>
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
