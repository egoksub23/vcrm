"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";

/**
 * Settings > Workspace: the owner's two data rights (migration 153).
 *   Export:  everything the workspace holds, as a zip.
 *   Delete:  a 30-day request that can be cancelled until it begins.
 * Everyone else sees that only the owner can do either.
 */
export function DataControlCard() {
  const t = useTranslations("DataControl");
  const f = useFormatter();
  const { isOwner, account, platform, refreshProfile } = useAuth();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const name = account?.name ?? "";
  const due = platform.deletionDueAt ? new Date(platform.deletionDueAt) : null;
  const dueText = due ? f.dateTime(due, { dateStyle: "long" }) : "";

  const ask = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/account/deletion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm, note: note.trim() || undefined }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; dueAt?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? t("failed"));
      toast.success(t("requested", { date: body?.dueAt ? f.dateTime(new Date(body.dueAt), { dateStyle: "long" }) : "" }));
      setOpen(false);
      setConfirm("");
      setNote("");
      await refreshProfile();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("failed"));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/account/deletion", { method: "DELETE" });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? t("failed"));
      toast.success(t("cancelled"));
      await refreshProfile();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-6 border-border bg-card">
      <CardContent className="space-y-5 p-5">
        <div>
          <h3 className="text-base font-semibold text-foreground">{t("title")}</h3>
          <p className="text-sm text-muted-foreground">{isOwner ? t("description") : t("ownerOnly")}</p>
        </div>

        {isOwner && (
          <>
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">{t("exportTitle")}</p>
              <p className="text-sm text-muted-foreground">{t("exportBody")}</p>
              <div className="flex flex-wrap gap-2">
                <Button render={<a href="/api/account/export" download />} variant="outline" size="sm">
                  <Download className="mr-1.5 h-4 w-4" />
                  {t("exportAll")}
                </Button>
                <Button render={<a href="/api/account/export?files=0" download />} variant="ghost" size="sm">
                  {t("exportDataOnly")}
                </Button>
              </div>
            </div>

            <div className="space-y-2 border-t border-border pt-5">
              <p className="text-sm font-medium text-destructive">{t("deleteTitle")}</p>
              {due ? (
                <>
                  <p className="text-sm text-foreground">{t("pendingBody", { date: dueText })}</p>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void cancel()}>
                    {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                    {t("cancelDeletion")}
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">{t("deleteBody")}</p>
                  <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
                    <Trash2 className="mr-1.5 h-4 w-4" />
                    {t("deleteButton")}
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={(o) => !o && !busy && setOpen(false)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("confirmTitle", { name })}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t("confirmBody")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="dc-confirm">{t("confirmLabel")}</Label>
              <Input id="dc-confirm" value={confirm} placeholder={name} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dc-note">{t("noteLabel")}</Label>
              <Textarea id="dc-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy || confirm.trim().toLowerCase() !== name.trim().toLowerCase() || !name}
              onClick={() => void ask()}
            >
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("confirmButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
