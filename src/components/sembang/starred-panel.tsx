"use client";

// Right-side Sheet listing the caller's own starred messages across every
// channel/DM — same Sheet structure as pins-panel.tsx (the closest
// existing analog), sourced from GET /api/sembang/stars. Personal list,
// not in the realtime publication (migration 100), so this just refetches
// on open — no realtime wiring, matching the spec's "update local state
// optimistically on toggle" note for the star action itself.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { useAccountMembers } from "@/hooks/use-account-members";
import { MessageBody } from "./message-body";
import type { SembangStarredMessage } from "@/types";

interface StarredPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function StarredPanel({ open, onOpenChange }: StarredPanelProps) {
  const t = useTranslations("Sembang.starredPanel");
  const router = useRouter();
  const { members: accountMembers } = useAccountMembers();
  const peopleNames = useMemo(() => accountMembers.map((m) => m.full_name), [accountMembers]);

  const [results, setResults] = useState<SembangStarredMessage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const res = await fetch("/api/sembang/stars", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        if (!cancelled) setResults((data.results as SembangStarredMessage[]) ?? []);
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

  // Reuses the existing `?c=<id>` deep link page.tsx already handles
  // (same mechanism the notifications page uses) rather than a new
  // selection path.
  const handleSelect = (channelId: string) => {
    router.push(`/sembang?c=${channelId}`);
    onOpenChange(false);
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
              <button
                key={r.message.id}
                type="button"
                onClick={() => handleSelect(r.channel.id)}
                className="block w-full rounded-lg border border-border p-2.5 text-left hover:bg-muted/40"
              >
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
                <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
                  {r.channel.isDm
                    ? r.channel.dmParticipantNames?.join(", ") || t("directMessage")
                    : `#${r.channel.name ?? ""}`}
                </p>
              </button>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
