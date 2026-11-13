"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronUp, Copy, ExternalLink, Loader2, Pencil, Plus, Send, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SCHOOL_WEBHOOK_EVENTS, type SchoolWebhookEvent, type SchoolWebhookView } from "@/lib/incidents/platform/school-webhooks";
import { api } from "./api";

interface ListData {
  webhooks: SchoolWebhookView[];
}

interface CreateResult {
  webhook: SchoolWebhookView;
  signing_secret: string;
}

const EVENT_LABELS: Record<SchoolWebhookEvent, string> = {
  "incident.filed": "Incident filed",
  "incident.closed": "Incident closed",
  "incident.escalated": "Incident escalated",
  "incident.status_changed": "Status changed",
};

function SecretBanner({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="rounded-xl border border-yellow-500/40 bg-yellow-50/60 p-4 dark:bg-yellow-900/20">
      <p className="mb-2 text-sm font-medium">Copy your signing secret now — it will not be shown again.</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">{secret}</code>
        <button type="button" onClick={() => void copy()} className="rounded p-1.5 hover:bg-muted">
          {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
        </button>
        <button type="button" onClick={onDismiss} className="rounded p-1.5 hover:bg-muted">
          <X size={14} />
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Use this on your server to verify the <code className="font-mono">X-Halo-Signature</code> header.
      </p>
    </div>
  );
}

function EventCheckboxes({ value, onChange }: { value: SchoolWebhookEvent[]; onChange: (v: SchoolWebhookEvent[]) => void }) {
  function toggle(e: SchoolWebhookEvent) {
    onChange(value.includes(e) ? value.filter((x) => x !== e) : [...value, e]);
  }
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {SCHOOL_WEBHOOK_EVENTS.map((e) => (
        <label key={e} className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" className="size-4 accent-primary" checked={value.includes(e)} onChange={() => toggle(e)} />
          {EVENT_LABELS[e]}
        </label>
      ))}
    </div>
  );
}

function AddForm({ onAdded }: { onAdded: (w: SchoolWebhookView, secret: string) => void }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [events, setEvents] = useState<SchoolWebhookEvent[]>([...SCHOOL_WEBHOOK_EVENTS]);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await api<CreateResult>("/api/incidents/setup/webhooks", "POST", { url, label: label || null, events });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    onAdded(res.data.webhook, res.data.signing_secret);
    setUrl(""); setLabel(""); setEvents([...SCHOOL_WEBHOOK_EVENTS]);
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <p className="text-sm font-medium">New webhook</p>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">Endpoint URL</label>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-server.example.com/halo-webhook" required />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">Label (optional)</label>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. SIS integration" maxLength={100} />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">Events</p>
        <EventCheckboxes value={events} onChange={setEvents} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={busy || !url.trim() || events.length === 0}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Add webhook
        </Button>
      </div>
    </form>
  );
}

function WebhookRow({ w, onUpdated, onDeleted }: { w: SchoolWebhookView; onUpdated: (next: SchoolWebhookView) => void; onDeleted: () => void }) {
  const t = useTranslations("IncidentPlatform.webhooks");
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(w.url);
  const [label, setLabel] = useState(w.label ?? "");
  const [events, setEvents] = useState<SchoolWebhookEvent[]>(w.events);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await api<{ webhook: SchoolWebhookView }>(`/api/incidents/setup/webhooks/${w.id}`, "PATCH", { url, label: label || null, events });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    onUpdated(res.data.webhook);
    setEditing(false);
    toast.success(t("saved"));
  }

  async function toggle() {
    const res = await api<{ webhook: SchoolWebhookView }>(`/api/incidents/setup/webhooks/${w.id}`, "PATCH", { enabled: !w.enabled });
    if (res.ok) onUpdated(res.data.webhook);
    else toast.error(res.error);
  }

  async function del() {
    if (!confirm(t("deleteConfirm"))) return;
    const res = await api(`/api/incidents/setup/webhooks/${w.id}`, "DELETE");
    if (res.ok) { onDeleted(); toast.success(t("deleted")); }
    else toast.error(res.error);
  }

  async function sendTest() {
    setBusy(true);
    const res = await api<{ ok: boolean; status_code: number | null }>(`/api/incidents/setup/webhooks/${w.id}/test`, "POST");
    setBusy(false);
    if (!res.ok) { toast.error(t("testFailed")); return; }
    if (res.data.ok) toast.success(t("testSent", { code: res.data.status_code ?? "—" }));
    else toast.warning(t("testSent", { code: res.data.status_code ?? "—" }));
  }

  const statusColor = w.last_status_code == null ? "" : w.last_status_code < 400 ? "text-green-600" : "text-red-600";

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={`size-2 rounded-full flex-shrink-0 ${w.enabled ? "bg-green-500" : "bg-muted-foreground"}`} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{w.label ?? w.url_host}</p>
          {w.label ? <p className="truncate text-xs text-muted-foreground">{w.url_host}</p> : null}
        </div>
        {w.last_status_code ? <span className={`text-xs font-mono ${statusColor}`}>{w.last_status_code}</span> : null}
        <button type="button" onClick={() => setExpanded((x) => !x)} className="rounded p-1 hover:bg-muted">
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>

      {expanded ? (
        <div className="border-t border-border px-4 pb-4 pt-3">
          {editing ? (
            <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">URL</label>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Label</label>
                <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} placeholder="optional" />
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-xs text-muted-foreground">Events</p>
                <EventCheckboxes value={events} onChange={setEvents} />
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={busy || !url.trim() || events.length === 0}>
                  {busy ? <Loader2 size={14} className="animate-spin" /> : null} Save
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <ExternalLink size={12} />
                <span className="truncate">{w.url}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {w.events.map((e) => (
                  <span key={e} className="rounded-full bg-muted px-2 py-0.5 text-xs">{EVENT_LABELS[e as SchoolWebhookEvent] ?? e}</span>
                ))}
              </div>
              {w.last_called_at ? (
                <p className="text-xs text-muted-foreground">
                  Last called {new Date(w.last_called_at).toLocaleString()}
                  {w.last_status_code ? <span className={` ml-1 font-mono ${statusColor}`}>HTTP {w.last_status_code}</span> : null}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{t("never")}</p>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil size={12} /> Edit</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => void toggle()}>{w.enabled ? "Disable" : "Enable"}</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => void sendTest()} disabled={busy}>
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} {t("test")}
                </Button>
                <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void del()}>
                  <Trash2 size={12} /> Delete
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function WebhooksScreen() {
  const t = useTranslations("IncidentPlatform.webhooks");
  const [webhooks, setWebhooks] = useState<SchoolWebhookView[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<ListData>("/api/incidents/setup/webhooks");
    if (res.ok) setWebhooks(res.data.webhooks);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  function onAdded(w: SchoolWebhookView, secret: string) {
    setWebhooks((prev) => [...prev, w]);
    setNewSecret(secret);
    setAdding(false);
    toast.success(t("added"));
  }

  if (loading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={14} className="animate-spin" /> Loading…</div>;

  return (
    <div className="flex flex-col gap-4">
      {newSecret ? <SecretBanner secret={newSecret} onDismiss={() => setNewSecret(null)} /> : null}

      {webhooks.length === 0 && !adding ? (
        <div className="rounded-xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          {t("none")}
        </div>
      ) : null}

      {webhooks.map((w) => (
        <WebhookRow
          key={w.id}
          w={w}
          onUpdated={(next) => setWebhooks((prev) => prev.map((x) => (x.id === next.id ? next : x)))}
          onDeleted={() => setWebhooks((prev) => prev.filter((x) => x.id !== w.id))}
        />
      ))}

      {adding ? <AddForm onAdded={onAdded} /> : null}

      {!adding ? (
        <div>
          <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus size={14} /> {t("add")}
          </Button>
        </div>
      ) : (
        <div>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
        </div>
      )}
    </div>
  );
}
