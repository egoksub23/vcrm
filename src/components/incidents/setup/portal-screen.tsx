"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";
import { Check, Copy, ExternalLink, KeyRound, Loader2, Plus, RotateCw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { api } from "./api";

export interface PortalKey {
  id: string;
  label: string;
  mode: "live" | "test";
  prefix: string;
  scopes: string[];
  allowed_origins: string[];
  webhook_url: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
interface PortalData {
  keys: PortalKey[];
  calls: { id: string; route: string; status: number; summary: string | null; created_at: string }[];
  address: string | null;
  retentionYears: number | null;
  guide: string;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useTranslations("IncidentPlatform.portal");
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          toast.error("Copy did not work. Select the text and copy it by hand.");
        }
      }}
    >
      {done ? <Check /> : <Copy />}
      {done ? t("copied") : label}
    </Button>
  );
}

/** Coach portal & API: keys, the addresses allowed to show the report, a test report, the call log and the hand-off guide. */
export function PortalScreen() {
  const t = useTranslations("IncidentPlatform.portal");
  const [data, setData] = useState<PortalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ key: string; mode: string } | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<PortalData>("/api/incidents/setup/portal");
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else setError(res.error);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [load]);

  if (error) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />;

  const create = async (mode: "live" | "test") => {
    setBusy(`create-${mode}`);
    const res = await api<{ secret: string }>("/api/incidents/setup/portal/keys", "POST", { mode });
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    setSecret({ key: res.data.secret, mode });
    await load();
  };
  const rotate = async (k: PortalKey) => {
    setBusy(k.id);
    const res = await api<{ secret: string }>(`/api/incidents/setup/portal/keys/${k.id}/rotate`, "POST");
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    setSecret({ key: res.data.secret, mode: k.mode });
    await load();
  };
  const revoke = async (k: PortalKey) => {
    if (!window.confirm(t("revokeConfirm"))) return;
    setBusy(k.id);
    const res = await api(`/api/incidents/setup/portal/keys/${k.id}`, "PATCH", { revoke: true });
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    await load();
  };
  const sendTest = async () => {
    setBusy("test");
    const res = await api<{ url: string }>("/api/incidents/setup/portal/test-report", "POST");
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    setTest(res.data.url);
  };

  const active = data.keys.filter((k) => !k.revoked_at);
  const revoked = data.keys.filter((k) => k.revoked_at);

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{t("addressTitle")}</h2>
        {data.address ? (
          <p className="mt-1 font-mono text-sm break-all">{data.address}</p>
        ) : (
          <p role="alert" className="mt-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">{t("addressNotSet")}</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">{t("addressHelp")}</p>
      </section>

      {secret ? (
        <section className="rounded-xl border-2 border-primary bg-primary/5 p-4" aria-live="polite">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold"><KeyRound className="size-4" />{t("secretTitle")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t("secretHelp")}</p>
          <p className="mt-2 rounded-lg bg-background px-3 py-2 font-mono text-sm break-all select-all">{secret.key}</p>
          <div className="mt-2 flex gap-2">
            <CopyButton text={secret.key} label={t("copy")} />
            <Button size="sm" onClick={() => setSecret(null)}>{t("dismissSecret")}</Button>
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-sm font-semibold">{t("keysTitle")}</h2>
          <Button variant="outline" size="sm" onClick={() => void create("test")} disabled={busy !== null}><Plus />{t("createTest")}</Button>
          <Button size="sm" onClick={() => void create("live")} disabled={busy !== null}><Plus />{t("createLive")}</Button>
        </div>
        {active.length === 0 ? <p className="text-sm text-muted-foreground">{t("noKeys")}</p> : null}
        <ul className="flex flex-col gap-3">
          {active.map((k) => (
            <KeyCard key={k.id} k={k} busy={busy === k.id} onRotate={() => void rotate(k)} onRevoke={() => void revoke(k)} onSaved={load} />
          ))}
        </ul>
        {revoked.length > 0 ? (
          <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
            {revoked.slice(0, 5).map((k) => (
              <li key={k.id} className="font-mono">{k.prefix}… · {k.label} · {t("revoked")}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{t("testTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("testHelp")}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => void sendTest()} disabled={busy === "test"}>
            {busy === "test" ? <Loader2 className="animate-spin" /> : null}
            {t("testButton")}
          </Button>
          {test ? (
            <a href={test} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-primary underline">
              <ExternalLink className="size-3.5" />
              {t("testOpen")}
            </a>
          ) : null}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t("callsTitle")}</h2>
        {data.calls.length === 0 ? <p className="text-sm text-muted-foreground">{t("noCalls")}</p> : null}
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
          {data.calls.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-2 text-xs">
              <span className={cn("w-9 shrink-0 font-mono font-semibold", c.status >= 400 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")}>{c.status}</span>
              <span className="w-28 shrink-0 font-mono">{c.route}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.summary}</span>
              <span className="shrink-0 text-muted-foreground">{formatDistanceToNowStrict(new Date(c.created_at))}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="mr-auto text-sm font-semibold">{t("guideTitle")}</h2>
          <CopyButton text={data.guide} label={t("copyGuide")} />
        </div>
        <p className="text-xs text-muted-foreground">{t("guideHelp")}</p>
        <pre className="max-h-96 overflow-auto rounded-xl border border-border bg-muted/40 p-4 text-xs leading-relaxed whitespace-pre-wrap">{data.guide}</pre>
      </section>
    </div>
  );
}

function KeyCard({ k, busy, onRotate, onRevoke, onSaved }: { k: PortalKey; busy: boolean; onRotate: () => void; onRevoke: () => void; onSaved: () => Promise<void> }) {
  const t = useTranslations("IncidentPlatform.portal");
  const [origins, setOrigins] = useState(k.allowed_origins.join(", "));
  const [hook, setHook] = useState(k.webhook_url ?? "");
  const [hookSecret, setHookSecret] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const res = await api(`/api/incidents/setup/portal/keys/${k.id}`, "PATCH", { allowed_origins: origins.split(/[\s,]+/).filter(Boolean) });
    setSaving(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success(t("saved"));
    await onSaved();
  };

  const saveHook = async () => {
    setSaving(true);
    const res = await api(`/api/incidents/setup/portal/keys/${k.id}`, "PATCH", { webhook_url: hook.trim() || null });
    setSaving(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success(t("saved"));
    await onSaved();
  };
  const showSecret = async () => {
    const res = await api<{ secret: string }>(`/api/incidents/setup/portal/keys/${k.id}/webhook-secret`);
    if (!res.ok) return void toast.error(res.error);
    setHookSecret(res.data.secret);
  };

  return (
    <li className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase", k.mode === "live" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/20 text-amber-800 dark:text-amber-300")}>{k.mode === "live" ? t("live") : t("test")}</span>
        <span className="font-mono text-sm">{k.prefix}…</span>
        <span className="text-sm text-muted-foreground">{k.label}</span>
        <span className="ml-auto text-xs text-muted-foreground">{k.last_used_at ? t("lastUsed", { when: `${formatDistanceToNowStrict(new Date(k.last_used_at))} ago` }) : t("neverUsed")}</span>
      </div>
      <label className="mt-3 flex flex-col gap-1 text-xs">
        {t("allowed")}
        <div className="flex gap-2">
          <Input value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://coach.example.edu.my" />
          <Button variant="outline" size="sm" className="h-8" onClick={() => void save()} disabled={saving}>{saving ? <Loader2 className="animate-spin" /> : null}{t("saveAllowed")}</Button>
        </div>
        <span className="text-muted-foreground">{t("allowedHelp")}</span>
      </label>
      <label className="mt-3 flex flex-col gap-1 text-xs">
        {t("events")}
        <div className="flex gap-2">
          <Input value={hook} onChange={(e) => setHook(e.target.value)} placeholder="https://coach.example.edu.my/hooks/halo" />
          <Button variant="outline" size="sm" className="h-8" onClick={() => void saveHook()} disabled={saving}>{t("saveEvents")}</Button>
        </div>
        <span className="text-muted-foreground">{t("eventsHelp")}</span>
      </label>
      {k.webhook_url ? (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <Button variant="ghost" size="sm" onClick={() => void showSecret()}>{t("showSecret")}</Button>
          {hookSecret ? (
            <>
              <code className="rounded bg-muted px-2 py-1 break-all select-all">{hookSecret}</code>
              <CopyButton text={hookSecret} label={t("copy")} />
            </>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRotate} disabled={busy}><RotateCw />{t("rotate")}</Button>
        <span className="text-xs text-muted-foreground">{t("rotateHelp")}</span>
        <Button variant="destructive" size="sm" className="ml-auto" onClick={onRevoke} disabled={busy}><Trash2 />{t("revoke")}</Button>
      </div>
    </li>
  );
}
