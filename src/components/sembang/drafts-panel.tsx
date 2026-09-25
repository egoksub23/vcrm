"use client";

// Global "Drafts" panel — lists every channel with a saved, unsent
// composer draft (see draft-storage.ts). Client-only: no backend, no
// cross-device sync, just "what was I about to say" for this browser.
// Thread-reply drafts aren't listed here (see draft-storage.ts's
// listDraftChannelIds comment) — only main-channel composer drafts.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Hash } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { listDraftChannelIds, readChannelDraft } from "@/lib/sembang/draft-storage";
import type { SembangChannelSummary } from "@/types";

interface DraftsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channels: SembangChannelSummary[] | null;
  onSelectChannel: (channelId: string) => void;
}

interface DraftRow {
  channelId: string;
  name: string;
  isDm: boolean;
  text: string;
}

export function DraftsPanel({ open, onOpenChange, channels, onSelectChannel }: DraftsPanelProps) {
  const t = useTranslations("Sembang.draftsPanel");
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null);

  useEffect(() => {
    if (!open) return;
    const channelById = new Map((channels ?? []).map((c) => [c.id, c]));
    const rows = listDraftChannelIds()
      .map((channelId): DraftRow | null => {
        const text = readChannelDraft(channelId);
        if (!text) return null;
        const channel = channelById.get(channelId);
        // A draft for a channel that's since been archived/left/deleted
        // (not in the currently-loaded sidebar list) is skipped rather
        // than shown with no name to click into.
        if (!channel) return null;
        return {
          channelId,
          name: channel.isDm
            ? (channel.dmParticipantNames?.join(", ") ?? t("directMessageFallback"))
            : (channel.name ?? ""),
          isDm: channel.isDm,
          text,
        };
      })
      .filter((r): r is DraftRow => r !== null);
    // localStorage is an external system, not React state — this effect
    // is exactly the sanctioned "synchronize from an external system"
    // case, not a derived-value calculation that belongs in render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrafts(rows);
  }, [open, channels, t]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-[420px]">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 space-y-1.5 overflow-y-auto px-4 pb-4">
          {drafts === null ? null : drafts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            drafts.map((d) => (
              <button
                key={d.channelId}
                type="button"
                onClick={() => {
                  onSelectChannel(d.channelId);
                  onOpenChange(false);
                }}
                className="flex w-full items-start gap-2 rounded-lg border border-border p-2.5 text-left hover:bg-muted/40"
              >
                {!d.isDm && <Hash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{d.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{d.text}</p>
                </div>
              </button>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
