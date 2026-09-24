"use client";

// "Browse public channels" dialog (migration 101) — public, non-DM
// channels the caller can see but hasn't joined. Fetch-on-open Dialog,
// mirrors archived-channels-dialog.tsx's structure. Joining reuses the
// EXISTING POST /api/sembang/channels/[id]/members route (no new join
// route needed — see SPEC-P3.md's backend item 8): on success the row is
// dropped from this list and the caller is told which channel to select.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import type { SembangBrowseChannel } from "@/types";

interface BrowseChannelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired once the caller successfully joins a channel — page.tsx selects
   *  it and refetches the sidebar list so it appears there. */
  onJoined: (channelId: string) => void;
}

export function BrowseChannelsDialog({ open, onOpenChange, onJoined }: BrowseChannelsDialogProps) {
  const t = useTranslations("Sembang.browseChannelsDialog");
  const { user } = useAuth();

  const [channels, setChannels] = useState<SembangBrowseChannel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const res = await fetch("/api/sembang/channels/browse", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        if (!cancelled) setChannels((data.channels as SembangBrowseChannel[]) ?? []);
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

  // Same shape as channel-thread.tsx's `handleJoin` — the route can return
  // 200 OR 207 (partial), both `res.ok`, so success must be read from
  // `added`, not the HTTP status alone.
  const handleJoin = async (channelId: string) => {
    if (!user?.id || joiningId) return;
    setJoiningId(channelId);
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: [user.id] }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        added?: string[];
        failed?: { userId: string; error: string }[];
        error?: string;
      };
      if (!res.ok || !data.added?.includes(user.id)) {
        toast.error(data.failed?.[0]?.error || data.error || t("joinFailed"));
        return;
      }
      setChannels((prev) => (prev ?? []).filter((c) => c.id !== channelId));
      onJoined(channelId);
    } catch {
      toast.error(t("joinFailed"));
    } finally {
      setJoiningId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="h-72 rounded-lg border border-border">
          <div className="flex flex-col p-1">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : error ? (
              <p className="py-6 text-center text-xs text-destructive">{t("loadFailed")}</p>
            ) : !channels || channels.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">{t("empty")}</p>
            ) : (
              channels.map((c) => (
                <div key={c.id} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">#{c.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {c.topic || t("noTopic")} · {t("memberCount", { count: c.memberCount })}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleJoin(c.id)}
                    disabled={joiningId === c.id}
                    className="shrink-0"
                  >
                    {joiningId === c.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {t("join")}
                  </Button>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
