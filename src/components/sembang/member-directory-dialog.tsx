"use client";

// Member directory dialog (migration 101) — everyone in the account who
// currently holds `menu.sembang` access, not just people who share a
// channel with the caller. Fetch-on-open Dialog, same shape as
// search-dialog.tsx/archived-channels-dialog.tsx. No "message" action for
// P3 — a row is informational only (avatar, name, role badge).

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import type { SembangDirectoryMember } from "@/types";

interface MemberDirectoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MemberDirectoryDialog({ open, onOpenChange }: MemberDirectoryDialogProps) {
  const t = useTranslations("Sembang.memberDirectoryDialog");

  const [members, setMembers] = useState<SembangDirectoryMember[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const res = await fetch("/api/sembang/directory", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        if (!cancelled) setMembers((data.members as SembangDirectoryMember[]) ?? []);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="h-80 rounded-lg border border-border">
          <div className="flex flex-col p-1">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : error ? (
              <p className="py-6 text-center text-xs text-destructive">{t("loadFailed")}</p>
            ) : !members || members.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">{t("empty")}</p>
            ) : (
              members.map((m) => (
                <div key={m.userId} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                  <PersonAvatar name={m.fullName} avatarUrl={m.avatarUrl} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{m.fullName}</span>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground capitalize">
                    {m.accountRole}
                  </span>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
