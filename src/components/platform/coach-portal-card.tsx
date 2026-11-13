"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";
import { Check, Copy, KeyRound, Loader2, Plus, RotateCw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { api } from "@/components/incidents/setup/api";

interface PlatformKey {
  id: string;
  label: string;
  mode: "live" | "test";
  prefix: string;
  webhook_url: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
interface SchoolLink {
  group_id: string;
  group_name: string;
  account_id: string;
  account_name: string | null;
  allowed_origins: string[];
  enabled: boolean;
}
interface PortalData {
  keys: PlatformKey[];
  schools: SchoolLink[];
  accounts: { id: string; name: string }[];
  calls: { id: string; account_name: string | null; route: string; status: number; summary: string | null; created_at: string }[];
  address: string | null;
  guide: string;
}

const fieldClass = "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** A school that is switched off cannot be tested. */
const isOff = (s: SchoolLink) => !s.enabled;

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useTranslations("IncidentPlatform.platformPortal");
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
          toast.error(t("copyFailed"));
        }
      }}
    >
      {done ? <Check /> : <Copy />}
      {done ? t("copied") : label}
    </Button>
  );
}

/**
 * Operator console: the coach portal as one platform integration. The platform key (one live, one test), where Halo sends events, and the Vircle Groups the
 * portal's calls may name, each mapped to a Halo school with that school's allowed web addresses. Schools only read their own link.
 */
export function CoachPortalCard() {
  const t = useTranslations("IncidentPlatform.platformPortal");
  const [data, setData] = useState<PortalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<PortalData>("/api/platform/coach-portal");
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else setError(res.error);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [load]);

  if (error) return <Card className="border-border bg-card"><CardContent className="p-4 text-sm text-red-600 dark:text-red-400" role="alert">{error}</CardContent></Card>;
  if (!data) return <Card className="border-border bg-card"><CardContent className="p-4"><Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t("loading")} /></CardContent></Card>;

  const create = async (mode: "live" | "test") => {
    setBusy(`create-${mode}`);
    const res = await api<{ secret: string }>("/api/platform/coach-portal", "POST", { mode });
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    setSecret(res.data.secret);
    await load();
  };
  const rotate = async (k: PlatformKey) => {
    setBusy(k.id);
    const res = await api<{ secret: string }>(`/api/platform/coach-portal/keys/${k.id}/rotate`, "POST");
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    setSecret(res.data.secret);
    await load();
  };
  const revoke = async (k: PlatformKey) => {
    if (!window.confirm(t("revokeConfirm"))) return;
    setBusy(k.id);
    const res = await api("/api/platform/coach-portal", "PATCH", { key_id: k.id, revoke: true });
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    await load();
  };

  const active = data.keys.filter((k) => !k.revoked_at);
  return (
    <Card className="border-border bg-card">
      <CardContent className="flex flex-col gap-6 p-4">
        <header>
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("help")}</p>
          {!data.address ? <p role="alert" className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">{t("addressNotSet")}</p> : null}
        </header>

        {secret ? (
          <section className="rounded-xl border-2 border-primary bg-primary/5 p-4" aria-live="polite">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold"><KeyRound className="size-4" />{t("secretTitle")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t("secretHelp")}</p>
            <p className="mt-2 rounded-lg bg-background px-3 py-2 font-mono text-sm break-all select-all">{secret}</p>
            <div className="mt-2 flex gap-2">
              <CopyButton text={secret} label={t("copy")} />
              <Button size="sm" onClick={() => setSecret(null)}>{t("dismissSecret")}</Button>
            </div>
          </section>
        ) : null}

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="mr-auto text-sm font-semibold">{t("keysTitle")}</h3>
            <Button variant="outline" size="sm" onClick={() => void create("test")} disabled={busy !== null}><Plus />{t("createTest")}</Button>
            <Button size="sm" onClick={() => void create("live")} disabled={busy !== null}><Plus />{t("createLive")}</Button>
          </div>
          {active.length === 0 ? <p className="text-sm text-muted-foreground">{t("noKeys")}</p> : null}
          <ul className="flex flex-col gap-3">
            {active.map((k) => <KeyRow key={k.id} k={k} busy={busy === k.id} onRotate={() => void rotate(k)} onRevoke={() => void revoke(k)} onSaved={load} />)}
          </ul>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{t("schoolsTitle")}</h3>
          <p className="text-xs text-muted-foreground">{t("schoolsHelp")}</p>
          {data.schools.length === 0 ? <p className="text-sm text-muted-foreground">{t("noSchools")}</p> : null}
          <ul className="flex flex-col gap-3">
            {data.schools.map((s) => <li key={s.group_id}><SchoolRow school={s} accounts={data.accounts} onSaved={load} /></li>)}
          </ul>
          <SchoolRow school={null} accounts={data.accounts} onSaved={load} />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t("callsTitle")}</h3>
          {data.calls.length === 0 ? <p className="text-sm text-muted-foreground">{t("noCalls")}</p> : null}
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {data.calls.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-2 text-xs">
                <span className={cn("w-9 shrink-0 font-mono font-semibold", c.status >= 400 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")}>{c.status}</span>
                <span className="w-28 shrink-0 truncate font-mono">{c.route}</span>
                <span className="w-40 shrink-0 truncate" title={t("callSchool")}>{c.account_name ?? "-"}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.summary}</span>
                <span className="shrink-0 text-muted-foreground">{formatDistanceToNowStrict(new Date(c.created_at))}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h3 className="mr-auto text-sm font-semibold">{t("guideTitle")}</h3>
            <CopyButton text={data.guide} label={t("copyGuide")} />
          </div>
          <p className="text-xs text-muted-foreground">{t("guideHelp")}</p>
          <pre className="max-h-96 overflow-auto rounded-xl border border-border bg-muted/40 p-4 text-xs leading-relaxed whitespace-pre-wrap">{data.guide}</pre>
        </section>
      </CardContent>
    </Card>
  );
}

function KeyRow({ k, busy, onRotate, onRevoke, onSaved }: { k: PlatformKey; busy: boolean; onRotate: () => void; onRevoke: () => void; onSaved: () => Promise<void> }) {
  const t = useTranslations("IncidentPlatform.platformPortal");
  const [hook, setHook] = useState(k.webhook_url ?? "");
  const [hookSecret, setHookSecret] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const saveHook = async () => {
    setSaving(true);
    const res = await api("/api/platform/coach-portal", "PATCH", { key_id: k.id, webhook_url: hook.trim() || null });
    setSaving(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success(t("saved"));
    await onSaved();
  };
  const showSecret = async () => {
    const res = await api<{ secret: string }>(`/api/platform/coach-portal/keys/${k.id}/webhook-secret`);
    if (!res.ok) return void toast.error(res.error);
    setHookSecret(res.data.secret);
  };

  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase", k.mode === "live" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/20 text-amber-800 dark:text-amber-300")}>{k.mode === "live" ? t("live") : t("test")}</span>
        <span className="font-mono text-sm">{k.prefix}…</span>
        <span className="text-sm text-muted-foreground">{k.label}</span>
        <span className="ml-auto text-xs text-muted-foreground">{k.last_used_at ? t("lastUsed", { when: `${formatDistanceToNowStrict(new Date(k.last_used_at))} ago` }) : t("neverUsed")}</span>
      </div>
      <label className="mt-3 flex flex-col gap-1 text-xs">
        {t("events")}
        <div className="flex gap-2">
          <Input value={hook} onChange={(e) => setHook(e.target.value)} placeholder="https://coach.example.edu.my/hooks/halo" />
          <Button variant="outline" size="sm" className="h-8" onClick={() => void saveHook()} disabled={saving}>{saving ? <Loader2 className="animate-spin" /> : null}{t("saveEvents")}</Button>
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

/** One Vircle Group mapped to a school; with `school` null it is the form for adding the next one. */
function SchoolRow({ school, accounts, onSaved }: { school: SchoolLink | null; accounts: { id: string; name: string }[]; onSaved: () => Promise<void> }) {
  const t = useTranslations("IncidentPlatform.platformPortal");
  const [groupId, setGroupId] = useState(school?.group_id ?? "");
  const [groupName, setGroupName] = useState(school?.group_name ?? "");
  const [accountId, setAccountId] = useState(school?.account_id ?? "");
  const [origins, setOrigins] = useState((school?.allowed_origins ?? []).join(", "));
  const [enabled, setEnabled] = useState(school?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [testUrl, setTestUrl] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    const res = await api("/api/platform/coach-portal", "PUT", { group_id: groupId, group_name: groupName, account_id: accountId, allowed_origins: origins.split(/[\s,]+/).filter(Boolean), enabled });
    setSaving(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success(t("saved"));
    if (!school) {
      setGroupId("");
      setGroupName("");
      setAccountId("");
      setOrigins("");
      setEnabled(true);
    }
    await onSaved();
  };
  const openTest = async () => {
    if (!school) return;
    const res = await api<{ url: string }>("/api/platform/coach-portal/test-report", "POST", { group_id: school.group_id });
    if (!res.ok) return void toast.error(res.error);
    setTestUrl(res.data.url);
  };
  const remove = async () => {
    if (!school || !window.confirm(t("removeConfirm"))) return;
    const res = await api(`/api/platform/coach-portal?group_id=${encodeURIComponent(school.group_id)}`, "DELETE");
    if (!res.ok) return void toast.error(res.error);
    await onSaved();
  };

  return (
    <div className={cn("rounded-xl border p-4", school ? "border-border" : "border-dashed border-border")}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          {t("groupId")}
          <Input value={groupId} onChange={(e) => setGroupId(e.target.value)} disabled={school !== null} placeholder="G-12" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {t("groupName")}
          <Input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="SMK Seri Puteri" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {t("haloSchool")}
          <select className={fieldClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">{t("chooseSchool")}</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {t("allowed")}
          <Input value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://coach.example.edu.my" />
        </label>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t("allowedHelp")}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-3.5 accent-primary" />
          {t("enabled")}
        </label>
        <Button size="sm" onClick={() => void save()} disabled={saving || !groupId.trim() || !groupName.trim() || !accountId}>
          {saving ? <Loader2 className="animate-spin" /> : school ? null : <Plus />}
          {school ? t("saveSchool") : t("addSchool")}
        </Button>
        {school ? <Button variant="outline" size="sm" onClick={() => void openTest()} disabled={isOff(school)}>{t("testReport")}</Button> : null}
        {testUrl ? <a href={testUrl} target="_blank" rel="noreferrer" className="text-sm font-medium text-primary underline">{t("testOpen")}</a> : null}
        {school ? <Button variant="ghost" size="sm" className="ml-auto text-destructive" onClick={() => void remove()}><Trash2 />{t("removeSchool")}</Button> : null}
      </div>
      {school ? <p className="mt-1 text-xs text-muted-foreground">{t("testReportHelp")}</p> : null}
    </div>
  );
}
