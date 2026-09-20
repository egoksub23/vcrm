"use client";

// The "Activity" button + drawer on an article, tag or snippet: who
// added, changed and removed that one item. Shown to people with
// audit.view only (the route and the database enforce it as well).

import { useEffect, useState } from "react";
import { History, Loader2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useCapability } from "@/hooks/use-auth";
import type { AuditEntry, AuditEntityType } from "@/lib/audit/types";

import { AuditActionBadge, AuditActor, AuditSummary, AuditTime } from "./audit-parts";

interface ActivityButtonProps {
  entityType: Extract<AuditEntityType, "tag" | "snippet" | "article">;
  entityId: string;
  /** The item's name, for the drawer's description. */
  entityLabel: string;
  /** Icon-only (rows in a table) or with the word "Activity". */
  compact?: boolean;
  className?: string;
}

export function ActivityButton({
  entityType,
  entityId,
  entityLabel,
  compact = false,
  className,
}: ActivityButtonProps) {
  const t = useTranslations("Audit.activity");
  const canView = useCapability("audit.view");
  const [open, setOpen] = useState(false);

  if (!canView) return null;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size={compact ? "icon-sm" : "sm"}
        className={className}
        aria-label={compact ? t("openAria", { name: entityLabel }) : undefined}
        title={compact ? t("button") : undefined}
        onClick={() => setOpen(true)}
      >
        <History className="size-4" />
        {compact ? null : t("button")}
      </Button>
      {open ? (
        <ActivityDrawer
          entityType={entityType}
          entityId={entityId}
          entityLabel={entityLabel}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ActivityDrawer({
  entityType,
  entityId,
  entityLabel,
  onClose,
}: {
  entityType: string;
  entityId: string;
  entityLabel: string;
  onClose: () => void;
}) {
  const t = useTranslations("Audit.activity");
  const format = useFormatter();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const ctrl = new AbortController();
    const params = new URLSearchParams({ entity_type: entityType, entity_id: entityId });
    fetch(`/api/account/audit/entity?${params.toString()}`, {
      cache: "no-store",
      signal: ctrl.signal,
    })
      .then(async (res) => {
        const payload = (await res.json().catch(() => ({}))) as { entries?: AuditEntry[] };
        if (!res.ok || !payload.entries) throw new Error();
        setEntries(payload.entries);
        setStatus("ready");
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setStatus("error");
      });
    return () => ctrl.abort();
  }, [entityType, entityId]);

  const day = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium" });
  const created = [...entries].reverse().find((e) => e.action === "created");
  const lastEdit = entries.find((e) => e.action === "updated");
  const who = (e: AuditEntry) => e.actor.name || t("someone");

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description", { name: entityLabel })}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
          {status === "loading" ? (
            <div className="flex items-center justify-center py-10" role="status">
              <Loader2 className="size-5 animate-spin text-primary" />
              <span className="sr-only">{t("loading")}</span>
            </div>
          ) : status === "error" ? (
            <p className="text-sm text-destructive" role="alert">
              {t("loadFailed")}
            </p>
          ) : entries.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {created ? t("addedBy", { name: who(created), date: day(created.createdAt) }) : null}
                {created && lastEdit ? "; " : null}
                {lastEdit ? t("editedBy", { name: who(lastEdit), date: day(lastEdit.createdAt) }) : null}
              </p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {entries.map((entry) => (
                  <li key={entry.id} className="space-y-1 px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <AuditActor actor={entry.actor} />
                      <AuditTime iso={entry.createdAt} />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <AuditActionBadge action={entry.action} />
                      <AuditSummary action={entry.action} summary={entry.summary} />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
