"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-auth";
import {
  RESTORE_CAPABILITY,
  type RemovedItem,
  type RestorableEntityType,
} from "@/lib/audit/types";

import { AuditEntityIcon } from "./audit-parts";

/** Settings > Audit log > Recently removed (last 90 days), with Restore. */
export function AuditRemovedTab() {
  const t = useTranslations("Settings.audit.removed");
  const tAudit = useTranslations("Audit");
  const format = useFormatter();

  const canTags = useCapability(RESTORE_CAPABILITY.tag);
  const canSnippets = useCapability(RESTORE_CAPABILITY.snippet);
  const canArticles = useCapability(RESTORE_CAPABILITY.article);
  const canRestore: Record<RestorableEntityType, boolean> = {
    tag: canTags,
    snippet: canSnippets,
    article: canArticles,
  };

  const [items, setItems] = useState<RemovedItem[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const res = await fetch("/api/account/audit/removed", { cache: "no-store" });
      const payload = (await res.json().catch(() => ({}))) as { items?: RemovedItem[] };
      if (!res.ok || !payload.items) throw new Error();
      setItems(payload.items);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function restore(item: RemovedItem) {
    setBusy(item.entityId);
    try {
      const res = await fetch("/api/account/audit/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_type: item.entityType, entity_id: item.entityId }),
      });
      const payload = (await res.json().catch(() => ({}))) as { code?: string };
      if (res.ok) {
        toast.success(t("restored", { name: item.label }));
        setItems((prev) => prev.filter((i) => i.entityId !== item.entityId));
      } else if (payload.code === "name_conflict") {
        toast.error(t("nameConflict", { name: item.label }));
      } else if (res.status === 404) {
        toast.error(t("gone"));
        void load();
      } else {
        toast.error(t("restoreFailed"));
      }
    } catch {
      toast.error(t("restoreFailed"));
    } finally {
      setBusy(null);
    }
  }

  const kindLabel = (item: RemovedItem) => {
    if (item.entityType === "tag") return t(`kind.${item.kind === "both" || item.kind === "label" ? item.kind : "tag"}`);
    return tAudit(`entities.${item.entityType}`);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("description")}</p>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {status === "loading" ? (
          <div className="flex items-center justify-center py-12" role="status">
            <Loader2 className="size-6 animate-spin text-primary" />
            <span className="sr-only">{t("loading")}</span>
          </div>
        ) : status === "error" ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center" role="alert">
            <p className="text-sm text-destructive">{t("loadFailed")}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t("retry")}
            </Button>
          </div>
        ) : items.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((item) => {
              const allowed = canRestore[item.entityType];
              const date = new Date(item.deletedAt);
              return (
                <li key={`${item.entityType}:${item.entityId}`} className="flex items-center gap-3 px-4 py-3">
                  <AuditEntityIcon type={item.entityType} className="size-5" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.label || kindLabel(item)}</p>
                    <p className="text-xs text-muted-foreground">
                      {kindLabel(item)} ·{" "}
                      {item.deletedByName
                        ? t("removedBy", { name: item.deletedByName })
                        : t("removedByUnknown")}{" "}
                      ·{" "}
                      <time
                        dateTime={item.deletedAt}
                        title={format.dateTime(date, { dateStyle: "medium", timeStyle: "medium" })}
                      >
                        {format.relativeTime(date)}
                      </time>
                    </p>
                    {item.entityType === "tag" ? (
                      <p className="text-xs text-muted-foreground">{t("tagNote")}</p>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void restore(item)}
                    disabled={!allowed || busy !== null}
                    title={allowed ? undefined : t("noPermission")}
                  >
                    {busy === item.entityId ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RotateCcw className="size-4" />
                    )}
                    {t("restore")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
