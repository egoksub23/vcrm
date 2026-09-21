"use client";

// ============================================================
// Web Widget v2 — who a website visitor really is, for the agent.
//
//   useWidgetIdentity(contactId, enabled)   loads
//        GET /api/contacts/[id]/widget-identity
//   <WidgetIdentityBadges />   "Verified in-app" (the host app signed the
//        identity) or "Unverified web claim" (the visitor typed it), inline
//        in the thread header. A guest shows nothing.
//   <WidgetDuplicateBar />     "Possible duplicate": an unverified claim
//        matched two contacts and was NOT merged automatically. Merge folds
//        the other contact into this one; Dismiss keeps them apart for good.
//
// Only fetched for a contact that has used the web widget.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { GitMerge, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCapability } from "@/hooks/use-can";
import { cn } from "@/lib/utils";

export interface WidgetIdentitySuggestion {
  id: string;
  other_contact: {
    id: string;
    name: string | null;
    phone: string | null;
    email: string | null;
  };
  created_at: string;
}

export interface WidgetIdentityData {
  level: "guest" | "claimed" | "verified" | null;
  source: string | null;
  suggestions: WidgetIdentitySuggestion[];
}

export function useWidgetIdentity(contactId: string | undefined, enabled: boolean) {
  const [data, setData] = useState<{ contactId: string; value: WidgetIdentityData } | null>(null);

  const load = useCallback(async () => {
    if (!contactId || !enabled) return;
    try {
      const res = await fetch(`/api/contacts/${contactId}/widget-identity`);
      if (!res.ok) return;
      const value = (await res.json()) as WidgetIdentityData;
      setData({ contactId, value });
    } catch {
      // Cosmetic: the header simply shows no badge.
    }
  }, [contactId, enabled]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // A value that belongs to another contact must never be shown.
  const value = data && data.contactId === contactId && enabled ? data.value : null;
  return { identity: value, reload: load };
}

export function WidgetIdentityBadges({
  identity,
  className,
}: {
  identity: WidgetIdentityData | null;
  className?: string;
}) {
  const t = useTranslations("Inbox.widgetIdentity");
  if (!identity) return null;
  const hasDuplicate = identity.suggestions.length > 0;
  if (identity.level !== "verified" && identity.level !== "claimed" && !hasDuplicate) return null;

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {identity.level === "verified" && (
        <Badge
          variant="outline"
          className="gap-1 border-emerald-500/40 text-[10px] text-emerald-600 dark:text-emerald-400"
          title={t("verifiedHint")}
        >
          <ShieldCheck className="h-3 w-3" />
          {t("verified")}
        </Badge>
      )}
      {identity.level === "claimed" && (
        <Badge
          variant="outline"
          className="gap-1 border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-400"
          title={t("claimedHint")}
        >
          <ShieldAlert className="h-3 w-3" />
          {t("claimed")}
        </Badge>
      )}
      {hasDuplicate && (
        <Badge
          variant="outline"
          className="gap-1 border-red-500/40 text-[10px] text-red-600 dark:text-red-400"
          title={t("duplicateHint")}
        >
          <GitMerge className="h-3 w-3" />
          {t("duplicate")}
        </Badge>
      )}
    </span>
  );
}

function describeContact(c: WidgetIdentitySuggestion["other_contact"], fallback: string): string {
  const parts = [c.name?.trim() || fallback, c.phone || null, c.email || null].filter(Boolean);
  return parts.join(" · ");
}

export function WidgetDuplicateBar({
  identity,
  onResolved,
}: {
  identity: WidgetIdentityData | null;
  /** Called after a merge or dismiss so the parent can refetch. */
  onResolved: (result: { action: "merge" | "dismiss" }) => void;
}) {
  const t = useTranslations("Inbox.widgetIdentity");
  const canMerge = useCapability("contacts.merge");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<WidgetIdentitySuggestion | null>(null);

  const resolve = useCallback(
    async (suggestion: WidgetIdentitySuggestion, action: "merge" | "dismiss") => {
      setBusyId(suggestion.id);
      try {
        const res = await fetch(`/api/contacts/merge-suggestions/${suggestion.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          toast.error(body.error ?? t("failed"));
          return;
        }
        toast.success(action === "merge" ? t("merged") : t("dismissed"));
        setConfirming(null);
        onResolved({ action });
      } catch {
        toast.error(t("failed"));
      } finally {
        setBusyId(null);
      }
    },
    [onResolved, t],
  );

  const suggestions = identity?.suggestions ?? [];
  if (suggestions.length === 0) return null;

  return (
    <>
      <div className="border-b border-border bg-amber-500/10 px-3 py-2 text-xs sm:px-4">
        {suggestions.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-0.5">
            <span className="min-w-0 text-foreground">
              <span className="font-medium">{t("duplicate")}</span>{" "}
              <span className="text-muted-foreground">
                {t("duplicateBody", { contact: describeContact(s.other_contact, t("unnamed")) })}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <GatedButton
                size="sm"
                variant="outline"
                canAct={canMerge}
                gateReason="merge contacts"
                disabled={busyId === s.id}
                onClick={() => setConfirming(s)}
              >
                <GitMerge className="h-3 w-3" />
                {t("merge")}
              </GatedButton>
              <GatedButton
                size="sm"
                variant="ghost"
                canAct={canMerge}
                gateReason="dismiss suggestions"
                disabled={busyId === s.id}
                onClick={() => void resolve(s, "dismiss")}
              >
                {busyId === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {t("dismiss")}
              </GatedButton>
            </span>
          </div>
        ))}
      </div>

      <Dialog open={!!confirming} onOpenChange={(open) => !open && !busyId && setConfirming(null)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t("confirmTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("confirmBody", {
                contact: confirming ? describeContact(confirming.other_contact, t("unnamed")) : "",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)} disabled={!!busyId}>
              {t("cancel")}
            </Button>
            <Button
              onClick={() => confirming && void resolve(confirming, "merge")}
              disabled={!!busyId}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {busyId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
