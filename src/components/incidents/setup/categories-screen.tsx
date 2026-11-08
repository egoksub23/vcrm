"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { invalidateIncidentStandardCache } from "@/hooks/use-incident-standard";
import { INCIDENT_FLAGS } from "@/lib/incidents/constants";
import { canDelete } from "@/lib/incidents/platform/categories";
import type { CategoriesView as Data, CategoryRow } from "@/lib/incidents/platform/categories-data";
import { api } from "./api";

const selectClass = "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export type { Data as CategoriesData };

/** Categories: the kinds of incident a school raises. The built-in template is shared, so a school first makes its own copy, then adds, renames and hides. */
export function CategoriesScreen() {
  const t = useTranslations("IncidentPlatform.categories");
  const { accountId } = useAuth();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<Data>("/api/incidents/setup/categories");
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

  // Every change answers with the new list; the raise form asks the server again, so forget what it had.
  const run = async (call: () => Promise<{ ok: true; data: Data } | { ok: false; error: string; status: number }>, done?: string) => {
    setBusy(true);
    const res = await call();
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    setData(res.data);
    if (accountId) invalidateIncidentStandardCache(accountId);
    if (done) toast.success(done);
  };

  return (
    <CategoriesView
      data={data}
      busy={busy}
      onCopy={() => void run(() => api<Data>("/api/incidents/setup/categories", "POST", { action: "copy" }), t("copied"))}
      onAdd={(name) => run(() => api<Data>("/api/incidents/setup/categories", "POST", { action: "add", name }))}
      onPatch={(id, body) => run(() => api<Data>(`/api/incidents/setup/categories/${id}`, "PATCH", body))}
      onDelete={(id) => run(() => api<Data>(`/api/incidents/setup/categories/${id}`, "DELETE"), t("deleted"))}
    />
  );
}

export function CategoriesView({
  data,
  busy,
  onCopy,
  onAdd,
  onPatch,
  onDelete,
}: {
  data: Data;
  busy: boolean;
  onCopy: () => void;
  onAdd: (name: string) => Promise<void>;
  onPatch: (id: string, body: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const t = useTranslations("IncidentPlatform.categories");
  const [name, setName] = useState("");

  if (!data.template.ownCopy) {
    return (
      <div className="flex flex-col gap-4">
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{t("sharedTitle", { name: data.template.name })}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("sharedHelp")}</p>
          <Button className="mt-3" size="sm" onClick={onCopy} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("makeCopy")}
          </Button>
        </section>
        <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2" aria-label={t("listLabel")}>
          {data.categories.map((c) => (
            <li key={c.id} className="truncate text-muted-foreground">{c.name}</li>
          ))}
        </ul>
      </div>
    );
  }

  const add = async () => {
    const value = name.trim();
    if (!value) return;
    await onAdd(value);
    setName("");
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-sm text-muted-foreground">{t("ownHelp", { name: data.template.name })}</p>
      <ul className="flex flex-col gap-2" aria-label={t("listLabel")}>
        {data.categories.map((c) => (
          <CategoryItem key={c.id} c={c} data={data} busy={busy} onPatch={onPatch} onDelete={onDelete} />
        ))}
      </ul>
      <form
        className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs">
          {t("newName")}
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("newPlaceholder")} maxLength={80} />
        </label>
        <Button type="submit" size="sm" disabled={busy || !name.trim()}>
          <Plus />
          {t("add")}
        </Button>
      </form>
    </div>
  );
}

function CategoryItem({ c, data, busy, onPatch, onDelete }: { c: CategoryRow; data: Data; busy: boolean; onPatch: (id: string, body: Record<string, unknown>) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const t = useTranslations("IncidentPlatform.categories");
  const tFlag = useTranslations("Incidents.flags");
  const [name, setName] = useState(c.name);
  const [description, setDescription] = useState(c.description ?? "");
  const deletable = canDelete(c.usage);

  const toggleFlag = (flag: string) => onPatch(c.id, { default_flags: c.default_flags.includes(flag) ? c.default_flags.filter((f) => f !== flag) : [...c.default_flags, flag] });

  return (
    <li className={cn("rounded-xl border border-border bg-card p-3", c.is_hidden && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== c.name && void onPatch(c.id, { name })}
          aria-label={t("name")}
          className="min-w-48 flex-1 font-medium"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t("startsAt")}
          <select className={selectClass} value={c.default_severity ?? ""} onChange={(e) => void onPatch(c.id, { default_severity: e.target.value || null })} aria-label={t("startsAt")}>
            <option value="">{t("noDefault")}</option>
            {data.severities.map((s) => <option key={s.slug} value={s.slug}>{s.label}</option>)}
          </select>
        </label>
        {c.is_hidden ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase">{t("hiddenBadge")}</span> : null}
        <Button variant="outline" size="sm" onClick={() => void onPatch(c.id, { hidden: !c.is_hidden })} disabled={busy}>
          {c.is_hidden ? <Eye /> : <EyeOff />}
          {c.is_hidden ? t("show") : t("hide")}
        </Button>
      </div>

      <details className="group mt-2">
        <summary className="cursor-pointer list-none text-xs font-medium text-primary marker:hidden">
          {t("more")} <span className="group-open:hidden">▸</span>
        </summary>
        <div className="mt-2 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            {t("description")}
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => description.trim() !== (c.description ?? "") && void onPatch(c.id, { description })}
              maxLength={300}
            />
          </label>
          <div>
            <p className="mb-1 text-xs font-medium">{t("involves")}</p>
            <p className="mb-1.5 text-xs text-muted-foreground">{t("involvesHelp")}</p>
            <div className="flex flex-wrap gap-1.5">
              {INCIDENT_FLAGS.map((flag) => {
                const on = c.default_flags.includes(flag);
                return (
                  <button
                    key={flag}
                    type="button"
                    aria-pressed={on}
                    disabled={busy}
                    onClick={() => void toggleFlag(flag)}
                    className={cn("rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium transition-colors", on ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-muted/40 text-muted-foreground hover:bg-muted")}
                  >
                    {tFlag(flag)}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>{t("usedBy", { incidents: c.usage.incidents, rules: c.usage.rules })}{c.usage.forms > 0 ? ` ${t("usedByForm")}` : ""}</span>
            {deletable ? (
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void onDelete(c.id)} disabled={busy}>
                <Trash2 />
                {t("delete")}
              </Button>
            ) : (
              <span>{t("hideInstead")}</span>
            )}
          </div>
        </div>
      </details>
    </li>
  );
}
