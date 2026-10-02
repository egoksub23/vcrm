"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { useCapability } from "@/hooks/use-can";
import { useSignedMediaUrl } from "@/hooks/use-signed-media-url";
import { PUBLIC_MEDIA_BUCKET } from "@/lib/storage/media-urls";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import { SettingsPanelHead } from "./settings-panel-head";
import { LanguageSelect } from "./language-select";
import { TimezonePicker } from "./sla/timezone-picker";

const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];

/**
 * Settings, Workspace: the workspace's own name plus how the app is
 * branded for this tenant: the product name and logo in the sidebar
 * (migration 133). Empty = the neutral product default.
 */
export function WorkspacePanel() {
  const t = useTranslations("Settings.workspace");
  const canEdit = useCapability("settings.workspace");
  const router = useRouter();
  const { account, refreshProfile } = useAuth();

  // Seeded once from the account; the panel owns the draft after that.
  const [name, setName] = useState(account?.name ?? "");
  const [brandName, setBrandName] = useState(account?.brand_name ?? "");
  const [logoUrl, setLogoUrl] = useState<string | null>(account?.brand_logo_url ?? null);
  const [senderName, setSenderName] = useState(account?.email_sender_name ?? "");
  const [replyTo, setReplyTo] = useState(account?.email_reply_to ?? "");
  const [locale, setLocale] = useState(account?.locale ?? "");
  const [timezone, setTimezone] = useState(account?.timezone ?? "UTC");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { src: logoPreview } = useSignedMediaUrl(logoUrl);

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) {
      toast.error(t("badType"));
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error(t("fileTooLarge"));
      return;
    }
    setUploading(true);
    try {
      // Public on purpose: the logo is shown to people who are not signed in
      // (emails, the sign-in page). A logo saved before the public-assets
      // bucket existed may still be a legacy chat-media URL; the preview
      // below signs those.
      const { publicUrl } = await uploadAccountMedia(PUBLIC_MEDIA_BUCKET, file, "brand");
      setLogoUrl(publicUrl);
    } catch (err) {
      console.error("[WorkspacePanel] logo upload failed:", err);
      toast.error(t("uploadFailed"));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          brand_name: brandName.trim() || null,
          brand_logo_url: logoUrl,
          email_sender_name: senderName.trim() || null,
          email_reply_to: replyTo.trim() || null,
          locale: locale || null,
          timezone,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? t("saveFailed"));
      }
      await refreshProfile();
      toast.success(t("saved"));
      // The language may have changed: re-render the page with it.
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      <Card className="border-border bg-card">
        <CardContent className="space-y-5 p-5">
          {!canEdit && <p className="text-sm text-muted-foreground">{t("noPermission")}</p>}

          <div className="space-y-1.5">
            <Label htmlFor="ws-name">{t("nameLabel")}</Label>
            <Input id="ws-name" value={name} maxLength={80} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t("nameHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ws-brand">{t("brandNameLabel")}</Label>
            <Input
              id="ws-brand"
              value={brandName}
              maxLength={60}
              placeholder={t("brandNamePlaceholder")}
              disabled={!canEdit}
              onChange={(e) => setBrandName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("brandNameHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ws-sender">{t("senderNameLabel")}</Label>
            <Input
              id="ws-sender"
              value={senderName}
              maxLength={60}
              placeholder={brandName.trim() || name}
              disabled={!canEdit}
              onChange={(e) => setSenderName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("senderNameHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ws-reply-to">{t("replyToLabel")}</Label>
            <Input
              id="ws-reply-to"
              type="email"
              value={replyTo}
              maxLength={254}
              placeholder="support@yourcompany.com"
              disabled={!canEdit}
              onChange={(e) => setReplyTo(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("replyToHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ws-language">{t("languageLabel")}</Label>
            <LanguageSelect id="ws-language" value={locale} onChange={setLocale} defaultLabel={t("languageDefault")} disabled={!canEdit} />
            <p className="text-xs text-muted-foreground">{t("languageHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ws-timezone">{t("timezoneLabel")}</Label>
            <TimezonePicker id="ws-timezone" value={timezone} onChange={setTimezone} disabled={!canEdit} />
            <p className="text-xs text-muted-foreground">{t("timezoneHint")}</p>
          </div>

          <div className="space-y-2">
            <Label>{t("logoLabel")}</Label>
            <div className="flex items-center gap-3">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
                {logoPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoPreview} alt="" className="h-full w-full object-cover" />
                ) : (
                  <ImagePlus className="h-5 w-5 text-muted-foreground" />
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept={LOGO_TYPES.join(",")}
                  className="hidden"
                  onChange={(e) => void onPickFile(e.target.files?.[0])}
                />
                <Button type="button" variant="outline" size="sm" disabled={!canEdit || uploading} onClick={() => fileRef.current?.click()}>
                  {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImagePlus className="mr-2 h-4 w-4" />}
                  {uploading ? t("uploading") : t("upload")}
                </Button>
                {logoUrl && (
                  <Button type="button" variant="ghost" size="sm" disabled={!canEdit} onClick={() => setLogoUrl(null)}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t("remove")}
                  </Button>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("logoHint")}</p>
          </div>

          <div className="flex justify-end">
            <Button disabled={!canEdit || saving || !name.trim()} onClick={() => void save()}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {saving ? t("saving") : t("save")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
