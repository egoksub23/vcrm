"use client";

// Dialog listing archived channels (moderator/admin visibility — the
// backend route is a plain RLS-scoped SELECT, see SPEC-P2.md backend item
// 4) with an "Unarchive" button each. Mirrors create-channel-dialog.tsx's
// Dialog usage. DMs are excluded entirely — the backend route doesn't
// return them, and this pass doesn't build DM archiving at all (see
// channel-thread.tsx's "Archive channel" action, which is hidden for a
// DM).

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Hash, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

/** GET /api/sembang/channels/archived's row shape — a narrower, ad hoc
 *  shape (not a full `SembangChannel`), defined inline per SPEC-P2.md's
 *  backend item 4 rather than added to src/types/index.ts. */
interface ArchivedChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  archivedAt: string;
}

interface ArchivedChannelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Refetches the sidebar's main channel list — an unarchived channel
   *  should reappear there. */
  onUnarchived: () => void;
}

export function ArchivedChannelsDialog({ open, onOpenChange, onUnarchived }: ArchivedChannelsDialogProps) {
  const t = useTranslations("Sembang.archivedChannelsDialog");

  const [channels, setChannels] = useState<ArchivedChannel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [unarchivingId, setUnarchivingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const res = await fetch("/api/sembang/channels/archived", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        if (!cancelled) setChannels((data.channels as ArchivedChannel[]) ?? []);
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

  const handleUnarchive = async (channelId: string) => {
    if (unarchivingId) return;
    setUnarchivingId(channelId);
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error || t("unarchiveFailed"));
        return;
      }
      setChannels((prev) => (prev ?? []).filter((c) => c.id !== channelId));
      onUnarchived();
    } catch {
      toast.error(t("unarchiveFailed"));
    } finally {
      setUnarchivingId(null);
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
                  {c.isPrivate ? (
                    <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{c.name}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleUnarchive(c.id)}
                    disabled={unarchivingId === c.id}
                    className="shrink-0"
                  >
                    {unarchivingId === c.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {t("unarchive")}
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
