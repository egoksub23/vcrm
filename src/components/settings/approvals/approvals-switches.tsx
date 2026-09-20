"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { ApprovalSettings } from "@/app/api/account/approvals/settings/route";

/**
 * "Agents need approval for: [Snippets] [Labels and tags]".
 *
 * Shows the current state and, for someone who may edit roles
 * (roles.manage), flips it through the Agent role's capabilities:
 *   Snippets  ON  = Agents lose snippets.manage (their snippets and edits
 *                   become proposals); OFF = back to editing directly.
 *   Labels and tags are always reviewed for Agents (they cannot be given
 *   tags.manage), so that switch is shown on and locked.
 * A confirmation lists the effect before anything changes.
 */
export function ApprovalsSwitches() {
  const t = useTranslations("Settings.approvals.switches");
  const [settings, setSettings] = useState<ApprovalSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/account/approvals/settings", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setSettings((await res.json()) as ApprovalSettings);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function apply(needsApproval: boolean) {
    setSaving(true);
    try {
      const res = await fetch("/api/account/approvals/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snippets: needsApproval }),
      });
      if (!res.ok) {
        toast.error(t("saveFailed"));
        return;
      }
      toast.success(t(needsApproval ? "savedOn" : "savedOff"));
      setConfirm(null);
      await load();
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (failed) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
        {t("loadFailed")}
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="flex justify-center rounded-xl border border-border bg-card p-6">
        <Loader2 className="size-5 animate-spin text-primary" />
      </div>
    );
  }

  const snippets = settings.snippets.needsApproval;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">{t("title")}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground" id="approvals-switch-snippets">
              {t("snippets.label")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(snippets ? "snippets.hintOn" : "snippets.hintOff")}
            </p>
          </div>
          <Switch
            aria-labelledby="approvals-switch-snippets"
            checked={snippets}
            disabled={!settings.canEdit || saving}
            onCheckedChange={(next) => setConfirm(next)}
          />
        </div>

        <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground" id="approvals-switch-tags">
              {t("tags.label")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(settings.tags.locked ? "tags.hintLocked" : "tags.hint")}
            </p>
          </div>
          <Switch
            aria-labelledby="approvals-switch-tags"
            checked={settings.tags.needsApproval}
            disabled
          />
        </div>
      </div>

      {!settings.canEdit ? (
        <p className="mt-3 text-xs text-muted-foreground">{t("needRoles")}</p>
      ) : null}

      <Dialog open={confirm !== null} onOpenChange={(o) => (!o && !saving ? setConfirm(null) : undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t(confirm ? "confirmOn.title" : "confirmOff.title")}</DialogTitle>
            <DialogDescription>{t(confirm ? "confirmOn.intro" : "confirmOff.intro")}</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-foreground">
            {(confirm ? (["one", "two", "three"] as const) : (["one", "two"] as const)).map((k) => (
              <li key={k}>{t(`${confirm ? "confirmOn" : "confirmOff"}.${k}`)}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)} disabled={saving}>
              {t("cancel")}
            </Button>
            <Button onClick={() => confirm !== null && apply(confirm)} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t(confirm ? "confirmOn.action" : "confirmOff.action")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
