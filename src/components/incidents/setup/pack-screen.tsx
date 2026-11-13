"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { INCIDENT_FLAGS } from "@/lib/incidents/constants";
import { describeDue } from "@/lib/incidents/platform/pack";
import { api } from "./api";

interface Step {
  id: string;
  code: string;
  title: string;
  description: string | null;
  trigger_flag: string;
  due_hours: number | null;
  role_key: string | null;
}
interface PackData {
  pack: { id: string; name: string } | null;
  steps: Step[];
  roles: { key: string; name: string }[];
  active: boolean;
}

const selectClass = "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** The school's own required steps: when an incident involves X, this role must do Y within Z hours. Added to new incidents, alongside the built-in packs. */
export function PackScreen() {
  const t = useTranslations("IncidentPlatform.pack");
  const tFlag = useTranslations("Incidents.flags");
  const [data, setData] = useState<PackData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Step | "new" | null>(null);

  const load = useCallback(async () => {
    const res = await api<PackData>("/api/incidents/setup/pack");
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

  if (!data.pack) {
    return (
      <section className="rounded-xl border border-border bg-card p-4">
        <p className="text-sm text-muted-foreground">{t("startHelp")}</p>
        <Button className="mt-3" size="sm" onClick={async () => { const res = await api("/api/incidents/setup/pack", "POST", { action: "create" }); if (!res.ok) toast.error(res.error); else await load(); }}>{t("start")}</Button>
      </section>
    );
  }

  const roleName = (key: string | null) => (key ? (data.roles.find((r) => r.key === key)?.name ?? key) : t("lead"));

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-sm text-muted-foreground">{t("help")}</p>
      {!data.active ? <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">{t("off")}</p> : null}
      <div><Button size="sm" onClick={() => setEditing("new")}><Plus />{t("add")}</Button></div>
      {editing ? (
        <StepForm
          key={editing === "new" ? "new" : editing.id}
          step={editing === "new" ? null : editing}
          roles={data.roles}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      ) : null}
      {data.steps.length === 0 ? <p className="text-sm text-muted-foreground">{t("none")}</p> : null}
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
        {data.steps.map((s) => (
          <li key={s.id} className="flex items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{s.title}</p>
              <p className="text-xs text-muted-foreground">
                {t("rowSentence", { involves: tFlag(s.trigger_flag), role: roleName(s.role_key), due: describeDue(s.due_hours) })}
              </p>
              {s.description ? <p className="mt-0.5 text-xs text-muted-foreground">{s.description}</p> : null}
            </div>
            <Button variant="ghost" size="icon-sm" aria-label={t("edit")} onClick={() => setEditing(s)}><Pencil /></Button>
            <Button variant="ghost" size="icon-sm" aria-label={t("remove")} onClick={async () => { const res = await api("/api/incidents/setup/pack", "POST", { action: "remove", id: s.id }); if (!res.ok) toast.error(res.error); else await load(); }}><Trash2 /></Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StepForm({ step, roles, onCancel, onSaved }: { step: Step | null; roles: PackData["roles"]; onCancel: () => void; onSaved: () => Promise<void> }) {
  const t = useTranslations("IncidentPlatform.pack");
  const tFlag = useTranslations("Incidents.flags");
  const [title, setTitle] = useState(step?.title ?? "");
  const [description, setDescription] = useState(step?.description ?? "");
  const [flag, setFlag] = useState(step?.trigger_flag ?? "injury");
  const [hours, setHours] = useState(step?.due_hours ? String(step.due_hours) : "");
  const [role, setRole] = useState(step?.role_key ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const res = await api("/api/incidents/setup/pack", "POST", { action: "save", id: step?.id, title, description, trigger_flag: flag, due_hours: hours || null, role_key: role || null });
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    await onSaved();
  };

  return (
    <form
      className="grid gap-3 rounded-xl border-2 border-primary/40 bg-card p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="flex flex-col gap-1 text-xs sm:col-span-2">
        {t("form.title")}
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("form.titlePlaceholder")} required />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        {t("form.when")}
        <select className={selectClass} value={flag} onChange={(e) => setFlag(e.target.value)}>
          {INCIDENT_FLAGS.map((f) => <option key={f} value={f}>{tFlag(f)}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs">
        {t("form.who")}
        <select className={selectClass} value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">{t("lead")}</option>
          {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs">
        {t("form.hours")}
        <Input type="number" min={1} max={8760} value={hours} onChange={(e) => setHours(e.target.value)} placeholder={t("form.noDeadline")} />
      </label>
      <label className="flex flex-col gap-1 text-xs sm:col-span-2">
        {t("form.description")}
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={busy || title.trim().length < 3}>{busy ? <Loader2 className="animate-spin" /> : null}{t("form.save")}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t("form.cancel")}</Button>
      </div>
    </form>
  );
}
