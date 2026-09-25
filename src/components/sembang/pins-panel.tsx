"use client";

// Right-side Sheet listing pinned messages — same pattern as
// members-panel.tsx. RLS gates who may actually unpin (the pinner, a
// moderator, or an admin); rather than duplicate that check client-side,
// the "Unpin" action is offered to everyone and a 403 from the route
// surfaces as a toast (see channel-thread.tsx's `handleUnpin`).

import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { Loader2, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { MessagePreview } from "./message-body";
import type { SembangPin } from "@/types";

interface PinsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pins: SembangPin[] | null;
  peopleNames: string[];
  onUnpin: (messageId: string) => void;
  unpinningId: string | null;
}

export function PinsPanel({ open, onOpenChange, pins, peopleNames, onUnpin, unpinningId }: PinsPanelProps) {
  const t = useTranslations("Sembang.pinsPanel");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-[420px]">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-4">
          {pins === null ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : pins.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            pins.map((p) => (
              <div key={p.messageId} className="rounded-lg border border-border p-2.5">
                <div className="flex items-start gap-2">
                  <PersonAvatar name={p.message.author?.fullName} avatarUrl={p.message.author?.avatarUrl} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="truncate text-xs font-semibold text-foreground">
                        {p.message.author?.fullName ?? t("unknownAuthor")}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {format(new Date(p.message.createdAt), "MMM d, HH:mm")}
                      </span>
                    </div>
                    <MessagePreview
                      body={p.message.body}
                      attachments={p.message.attachments}
                      peopleNames={peopleNames}
                    />
                  </div>
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <p className="truncate text-[11px] text-muted-foreground">{t("pinnedBy", { name: p.pinnedByName })}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onUnpin(p.messageId)}
                    disabled={unpinningId === p.messageId}
                    className="shrink-0"
                  >
                    {unpinningId === p.messageId ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <PinOff className="h-3.5 w-3.5" />
                    )}
                    {t("unpin")}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
