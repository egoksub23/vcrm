"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Timer, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth, useCapability } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useTranslations } from "next-intl";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Response time settings — account-wide SLA target, in minutes.
 *
 * A single global target (migration 049), not per-team/per-priority —
 * that's a bigger feature for later. Drives the Inbox's "aging
 * response" indicator color and the breach-alert cron
 * (`/api/sla/cron`). Writes go straight to `accounts.sla_response_minutes`;
 * the `accounts_update` RLS policy (017) already restricts that to
 * admins+, mirroring `DealsSettings`'s currency field exactly.
 */
export function ResponseTimeSettings() {
  const supabase = createClient();
  const {
    accountId,
    slaResponseMinutes,
    profileLoading,
    refreshProfile,
  } = useAuth();
  const canEditWorkspace = useCapability('settings.workspace');

  const [minutes, setMinutes] = useState(String(slaResponseMinutes));
  const [saving, setSaving] = useState(false);
  const t = useTranslations("Settings.responseTime");

  useEffect(() => {
    setMinutes(String(slaResponseMinutes));
  }, [slaResponseMinutes]);

  const parsed = Number(minutes);
  const valid = Number.isInteger(parsed) && parsed > 0;
  const dirty = valid && parsed !== slaResponseMinutes;

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    const { error } = await supabase
      .from("accounts")
      .update({ sla_response_minutes: parsed })
      .eq("id", accountId);
    if (error) {
      toast.error(t("saveFailed"));
      setSaving(false);
      return;
    }
    await refreshProfile();
    setSaving(false);
    toast.success(t("saveSuccess"));
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Timer className="size-4 text-primary" />
            {t("target")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("targetDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label className="text-muted-foreground">{t("minutesLabel")}</Label>
            <Input
              type="number"
              min={1}
              step={1}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              disabled={!canEditWorkspace || profileLoading}
            />
            {!valid && (
              <p className="text-xs text-destructive">{t("invalidMinutes")}</p>
            )}
            {!canEditWorkspace && (
              <p className="text-xs text-muted-foreground">{t("adminOnlyHint")}</p>
            )}
          </div>

          {canEditWorkspace && (
            <Button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
