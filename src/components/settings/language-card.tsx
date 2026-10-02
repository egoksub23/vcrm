"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { normalizeLocale } from "@/lib/i18n/locales";
import { createClient } from "@/lib/supabase/client";
import { LanguageSelect } from "./language-select";

/**
 * A person's own language (migration 144). Empty means "follow my workspace".
 * Saved on the profile row, which row security already restricts to its owner.
 */
export function LanguageCard() {
  const t = useTranslations("Settings.profile.language");
  const router = useRouter();
  const { user } = useAuth();
  const [saved, setSaved] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void createClient()
      .from("profiles")
      .select("locale")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const current = normalizeLocale((data as { locale?: string | null } | null)?.locale) ?? "";
        setSaved(current);
        setValue(current);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (saved === null) return null;

  const save = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const { error } = await createClient()
        .from("profiles")
        .update({ locale: value || null })
        .eq("user_id", user.id);
      if (error) throw error;
      setSaved(value);
      toast.success(t("saved"));
      // Re-render the page in the new language.
      router.refresh();
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-6 max-w-2xl border-border bg-card">
      <CardContent className="space-y-3 p-5">
        <div className="space-y-1.5">
          <Label htmlFor="profile-language">{t("label")}</Label>
          <LanguageSelect id="profile-language" value={value} onChange={setValue} defaultLabel={t("followWorkspace")} />
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
        </div>
        <Button type="button" size="sm" disabled={busy || value === saved} onClick={() => void save()}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t("save")}
        </Button>
      </CardContent>
    </Card>
  );
}
