"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChannelSettings } from "@/lib/incidents/platform/channels-data";
import { api } from "./api";

interface View {
  settings: ChannelSettings;
  server: { sms: boolean; push: boolean };
  whatsapp_connected: boolean;
  available: string[];
  categories: { code: string; name: string }[];
  email_in_url: string | null;
}

const selectClass = "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" className="size-4 accent-primary" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Channels: who gets a notice on WhatsApp, SMS or push besides email, and the address that turns an email into an incident. */
export function ChannelsScreen() {
  const t = useTranslations("IncidentPlatform.channels");
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [template, setTemplate] = useState("");
  const [language, setLanguage] = useState("en");
  const [senders, setSenders] = useState("");

  const adopt = useCallback((v: View) => {
    setView(v);
    setTemplate(v.settings.whatsapp_template_name ?? "");
    setLanguage(v.settings.whatsapp_template_language);
    setSenders(v.settings.email_in_senders.join("\n"));
  }, []);

  const load = useCallback(async () => {
    const res = await api<View>("/api/incidents/setup/channels");
    if (res.ok) adopt(res.data);
  }, [adopt]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [load]);

  async function save(patch: Record<string, unknown>, done?: string) {
    setBusy(true);
    const res = await api<View>("/api/incidents/setup/channels", "PUT", patch);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    adopt(res.data);
    toast.success(done ?? t("saved"));
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  }

  if (!view) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />;
  const s = view.settings;
  const ready = (channel: string) => view.available.includes(channel);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5" aria-label={t("tellTitle")}>
        <header>
          <h2 className="text-sm font-semibold">{t("tellTitle")}</h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{t("tellHelp")}</p>
        </header>

        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <Switch on={s.whatsapp_enabled} label={t("whatsapp")} disabled={busy} onChange={(on) => void save({ whatsapp_enabled: on })} />
          <p className="max-w-2xl text-xs text-muted-foreground">{t.raw("whatsappHelp") as string}</p>
          <p className="text-xs">{view.whatsapp_connected ? t("whatsappConnected") : t("whatsappNotConnected")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input value={template} onChange={(e) => setTemplate(e.target.value)} placeholder="incident_notice" aria-label={t("templateName")} className="h-8 w-60" disabled={busy} maxLength={512} />
            <Input value={language} onChange={(e) => setLanguage(e.target.value)} aria-label={t("templateLanguage")} className="h-8 w-24" disabled={busy} maxLength={6} />
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void save({ whatsapp_template_name: template.trim() || null, whatsapp_template_language: language.trim() || "en" })}>
              {t("saveTemplate")}
            </Button>
          </div>
          <p className="max-w-2xl text-xs text-muted-foreground">{t("templateHelp")}</p>
          <p className="text-xs font-medium">{ready("whatsapp") ? t("ready") : t("notReady")}</p>
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <Switch on={s.sms_enabled} label={t("sms")} disabled={busy} onChange={(on) => void save({ sms_enabled: on })} />
          <p className="max-w-2xl text-xs text-muted-foreground">{t("smsHelp")}</p>
          <p className="text-xs">{view.server.sms ? t("serverReady") : t("serverMissing")}</p>
          <p className="text-xs font-medium">{ready("sms") ? t("ready") : t("notReady")}</p>
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <Switch on={s.push_enabled} label={t("push")} disabled={busy} onChange={(on) => void save({ push_enabled: on })} />
          <p className="max-w-2xl text-xs text-muted-foreground">{t("pushHelp")}</p>
          <p className="text-xs">{view.server.push ? t("serverReady") : t("serverMissing")}</p>
          <p className="text-xs font-medium">{ready("push") ? t("ready") : t("notReady")}</p>
        </div>

        <p className="border-t border-border pt-4 text-xs text-muted-foreground">{t("emailAlso")}</p>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5" aria-label={t("inTitle")}>
        <header>
          <h2 className="text-sm font-semibold">{t("inTitle")}</h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{t("inHelp")}</p>
        </header>
        <Switch on={s.email_in_enabled} label={t("inOn")} disabled={busy} onChange={(on) => void save({ email_in_enabled: on })} />

        {s.email_in_enabled && view.email_in_url ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <code className="max-w-full overflow-x-auto rounded-md border border-border bg-muted px-2 py-1 text-xs">{view.email_in_url}</code>
              <Button size="sm" variant="outline" onClick={() => void copy(view.email_in_url as string)}>
                <Copy className="size-3.5" />
                {t("copy")}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void save({ regenerate_token: true }, t("regenerated"))}>
                <RefreshCw className="size-3.5" />
                {t("regenerate")}
              </Button>
            </div>
            <p className="max-w-2xl text-xs text-muted-foreground">{t("regenerateHelp")}</p>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t("senders")}</span>
              <textarea
                className="min-h-24 w-full max-w-md rounded-lg border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={senders}
                onChange={(e) => setSenders(e.target.value)}
                placeholder={"@school.edu\ncoach@school.edu"}
                disabled={busy}
              />
              <span className="text-xs text-muted-foreground">{t("sendersHelp")}</span>
            </label>

            <label className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t("category")}</span>
              <select className={selectClass} value={s.email_in_category ?? ""} onChange={(e) => void save({ email_in_category: e.target.value || null })} disabled={busy}>
                <option value="">{t("categoryFirst")}</option>
                {view.categories.map((c) => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </select>
            </label>

            <div>
              <Button size="sm" disabled={busy} onClick={() => void save({ email_in_senders: senders.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean) })}>
                {t("saveSenders")}
              </Button>
            </div>
            {s.email_in_senders.length === 0 ? <p className="text-xs text-amber-700 dark:text-amber-400">{t("noSenders")}</p> : null}

            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">{t("howTitle")}</summary>
              <p className="mt-2 max-w-2xl">{t("how")}</p>
              <pre className="mt-2 max-w-full overflow-x-auto rounded-md border border-border bg-muted p-2">{`POST ${view.email_in_url}\nContent-Type: application/json\n\n{ "from": "coach@school.edu", "subject": "Twisted ankle at football", "text": "…", "message_id": "<abc@mail>" }`}</pre>
            </details>
          </>
        ) : null}
      </section>
    </div>
  );
}
