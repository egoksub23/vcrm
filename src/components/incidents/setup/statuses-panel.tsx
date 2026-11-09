"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { invalidateStatusOptions } from "@/hooks/use-status-options";
import { BASE_STATUSES, MAX_LABEL, type StatusOption } from "@/lib/incidents/platform/statuses";
import type { StatusesView } from "@/lib/incidents/platform/statuses-data";
import { api } from "./api";

const selectClass = "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Statuses: the six built-in ones stay (timers, rules, requirements and reports work on them), but a school can rename them and add its own, each counting as
 * one of the six. Shown on the Rules page, next to what must be true before an incident moves on.
 */
export function StatusesPanel() {
  const t = useTranslations("IncidentPlatform.statuses");
  const tBase = useTranslations("Incidents.common.status");
  const [data, setData] = useState<StatusesView | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [base, setBase] = useState<string>("investigating");
  const [edits, setEdits] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await api<StatusesView>("/api/incidents/setup/statuses");
    if (res.ok) setData(res.data);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [load]);

  async function change(body: Record<string, unknown>, done?: string) {
    setBusy(true);
    const res = await api<StatusesView>("/api/incidents/setup/statuses", "POST", body);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    setData(res.data);
    invalidateStatusOptions();
    if (done) toast.success(done);
  }

  if (!data) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />;

  const shown = (o: StatusOption) => edits[o.key] ?? o.label ?? tBase(o.base as never);
  const extras = data.options.filter((o) => !o.builtin).length;

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5" aria-label={t("title")}>
      <header>
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{t("help")}</p>
      </header>

      <ul className="flex flex-col gap-2">
        {BASE_STATUSES.map((b) => (
          <li key={b} className="flex flex-col gap-1.5">
            {data.options.filter((o) => o.base === b).map((o) => (
              <div key={o.key} className={o.builtin ? "flex flex-wrap items-center gap-2" : "ml-8 flex flex-wrap items-center gap-2"}>
                <Input
                  value={shown(o)}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [o.key]: e.target.value }))}
                  maxLength={MAX_LABEL}
                  aria-label={o.builtin ? tBase(o.base as never) : o.label ?? ""}
                  className="h-8 w-60"
                  disabled={busy}
                  onBlur={() => {
                    const next = edits[o.key];
                    if (next === undefined || next.trim() === (o.label ?? tBase(o.base as never))) return setEdits(({ [o.key]: _drop, ...rest }) => rest);
                    void change({ action: "rename", key: o.key, label: next }, t("renamed")).then(() => setEdits(({ [o.key]: _drop, ...rest }) => rest));
                  }}
                />
                {o.builtin ? (
                  <span className="text-xs text-muted-foreground">{t("builtin")}</span>
                ) : (
                  <>
                    <span className="text-xs text-muted-foreground">{t("counts", { base: tBase(o.base as never) })}</span>
                    {data.usage[o.key] ? <span className="text-xs text-muted-foreground">{t("inUse", { count: data.usage[o.key] })}</span> : null}
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void change({ action: "hide", key: o.key, active: !o.active })}>
                      {o.active ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      {o.active ? t("hide") : t("show")}
                    </Button>
                    {!data.usage[o.key] ? (
                      <Button variant="outline" size="sm" disabled={busy} className="text-destructive" onClick={() => void change({ action: "delete", key: o.key }, t("deleted"))}>
                        <Trash2 className="size-3.5" />
                        {t("delete")}
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
            ))}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_LABEL} placeholder={t("newPlaceholder")} aria-label={t("newLabel")} className="h-8 w-60" disabled={busy || extras >= data.max} />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("countsAs")}</span>
          <select className={selectClass} value={base} onChange={(e) => setBase(e.target.value)} disabled={busy}>
            {BASE_STATUSES.filter((b) => b !== "reported").map((b) => <option key={b} value={b}>{tBase(b as never)}</option>)}
          </select>
        </label>
        <Button size="sm" disabled={busy || !name.trim() || extras >= data.max} onClick={() => void change({ action: "add", label: name, base }, t("added")).then(() => setName(""))}>
          <Plus />
          {t("add")}
        </Button>
        {extras >= data.max ? <span className="text-xs text-muted-foreground">{t("limit", { max: data.max })}</span> : null}
      </div>
    </section>
  );
}
