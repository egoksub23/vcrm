"use client";

import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { History, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import type { KnowledgeVersion } from "@/lib/knowledge-types";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { unwrapList } from "./kb-editor-utils";

/**
 * Edit history: the earlier saved versions of an article, newest first, with
 * a Restore button. Restoring is a save on the server (it keeps the current
 * text as a version first), so `onRestored` makes the parent reload the
 * article to show the restored text.
 */
export function KbHistory({
  articleId,
  open,
  onOpenChange,
  canRestore,
  onRestored,
}: {
  articleId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canRestore: boolean;
  onRestored: () => void;
}) {
  const t = useTranslations("Knowledge.editor");
  const [versions, setVersions] = useState<KnowledgeVersion[] | null>(null);
  const [error, setError] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch(`/api/knowledge/${articleId}/versions`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(true);
        return;
      }
      setVersions(unwrapList<KnowledgeVersion>(data, "versions"));
    } catch {
      setError(true);
    }
  }, [articleId]);

  useEffect(() => {
    if (open) {
      setVersions(null);
      void load();
    }
  }, [open, load]);

  async function restore(v: KnowledgeVersion) {
    if (!window.confirm(t("restoreConfirm", { date: format(new Date(v.created_at), "d MMM yyyy, HH:mm") }))) return;
    setRestoring(v.id);
    try {
      const res = await fetch(`/api/knowledge/${articleId}/versions/${v.id}/restore`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof data.error === "string" ? data.error : t("restoreFailed"));
        return;
      }
      toast.success(t("restored"));
      onOpenChange(false);
      onRestored();
    } catch {
      toast.error(t("restoreFailed"));
    } finally {
      setRestoring(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="p-4">
        <SheetHeader className="p-0">
          <SheetTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> {t("historyTitle")}
          </SheetTitle>
          <SheetDescription>{t("historyHint")}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {versions === null && !error ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : error ? (
            <div className="space-y-2 py-6 text-center">
              <p className="text-sm text-destructive">{t("historyLoadFailed")}</p>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                {t("retry")}
              </Button>
            </div>
          ) : versions && versions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("historyEmpty")}</p>
          ) : (
            <ul className="space-y-2">
              {versions?.map((v) => (
                <li key={v.id} className="flex items-start gap-2 rounded-lg border border-border p-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground" title={v.title}>
                      {v.title}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(v.created_at), "d MMM yyyy, HH:mm")}
                      {v.edited_by_name ? ` · ${v.edited_by_name}` : ""}
                    </p>
                  </div>
                  {canRestore && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={restoring !== null}
                      onClick={() => void restore(v)}
                    >
                      {restoring === v.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("restore")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
