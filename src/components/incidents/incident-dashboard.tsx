"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CheckSquare, ChevronDown, Download, Filter, HeartPulse, KanbanSquare, List, Loader2, Plus, ShieldAlert, UserCheck, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAuth, useCapability } from "@/hooks/use-auth";
import { useAccountMembers } from "@/hooks/use-account-members";
import { useIncidents } from "@/hooks/use-incidents";
import { useIncidentStandard } from "@/hooks/use-incident-standard";
import { INCIDENT_FLAGS, INCIDENT_STATUSES, LIST_PAGE_SIZE } from "@/lib/incidents/constants";
import type { Overview } from "@/lib/incidents/platform/overview";
import {
  activeCount,
  applyFilters,
  NO_LEAD,
  parseFilters,
  parseView,
  toggle,
  toParams,
  type DashboardFilters,
  type DashboardView,
} from "@/lib/incidents/platform/dashboard";
import { api } from "@/components/incidents/setup/api";
import { ClearancesScreen } from "@/components/incidents/clearances-screen";
import { IncidentBoard } from "@/components/incidents/incident-board";
import { IncidentListView } from "@/components/incidents/incident-list-view";
import { RaiseIncidentDialog } from "@/components/incidents/raise-incident-dialog";

const VIEW_STORAGE_KEY = "wacrm:incidents:view";

const fieldClass = "h-8 rounded-lg border border-input bg-card px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

interface Option {
  value: string;
  label: string;
}

/** A filter that takes several values: a button that shows how many are picked, and a list of boxes to tick. */
export function MultiFilter({ label, options, selected, onChange }: { label: string; options: Option[]; selected: string[]; onChange: (next: string[]) => void }) {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className={cn("h-8 shrink-0", selected.length > 0 && "border-primary text-primary")} />}>
        {label}
        {selected.length > 0 ? <span className="ml-1 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">{selected.length}</span> : null}
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-72 w-64 gap-1 overflow-y-auto p-2">
        <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">{label}</p>
        {options.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted">
            <input type="checkbox" checked={selected.includes(o.value)} onChange={() => onChange(toggle(selected, o.value))} className="size-3.5 accent-primary" />
            <span className="min-w-0 truncate">{o.label}</span>
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function Stat({ value, label, tone, active, onClick }: { value: number; label: string; tone?: "warn"; active?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <span className={cn("text-xl font-semibold tabular-nums", tone === "warn" && value > 0 && "text-red-600 dark:text-red-400")}>{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </>
  );
  const box = "flex flex-col items-start gap-0.5 rounded-xl border bg-card px-4 py-2.5 text-left";
  return onClick ? (
    <button type="button" aria-pressed={active} onClick={onClick} className={cn(box, "transition-colors hover:bg-muted/50", active ? "border-primary ring-1 ring-primary" : "border-border")}>
      {body}
    </button>
  ) : (
    <div className={cn(box, "border-border")}>{body}</div>
  );
}

/**
 * The incident dashboard: the numbers, the filters and the views (board, list, and for the nurse the return-to-play roster) on one page.
 * The filters and the view live in the address, so a view can be bookmarked or sent to someone.
 */
export function IncidentDashboard() {
  const t = useTranslations("Incidents.list");
  const tView = useTranslations("Incidents.view");
  const tStatus = useTranslations("Incidents.common.status");
  const tFlag = useTranslations("Incidents.flags");
  const td = useTranslations("IncidentPlatform.dashboard");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const canManage = useCapability("incidents.manage");
  const canPlay = useCapability("incidents.medical");
  const { members } = useAccountMembers();
  const { rows, involved, loading, error, reload, applyPatch } = useIncidents();
  const { types, severities } = useIncidentStandard();

  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const view = parseView(searchParams, canPlay);
  const go = (next: DashboardFilters, nextView: DashboardView = view) => {
    const qs = toParams(next, nextView).toString();
    window.history.replaceState(null, "", qs ? `/incidents?${qs}` : "/incidents");
  };
  const set = (patch: Partial<DashboardFilters>) => go({ ...filters, ...patch });
  const changeView = (next: DashboardView) => {
    go(filters, next);
    if (next !== "play") {
      try {
        localStorage.setItem(VIEW_STORAGE_KEY, next);
      } catch {
        // storage blocked: the choice just is not remembered
      }
    }
  };

  // A person who last chose the list gets the list again, unless the address already says which view.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("view")) return;
    try {
      if (localStorage.getItem(VIEW_STORAGE_KEY) === "list") go(parseFilters(new URLSearchParams(window.location.search)), "list");
    } catch {
      // storage blocked
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the page opens
  }, []);

  const [overview, setOverview] = useState<Overview | null>(null);
  const loadOverview = async () => {
    const res = await api<{ overview: Overview }>("/api/incidents/overview");
    if (res.ok) setOverview(res.data.overview);
  };
  useEffect(() => {
    let live = true;
    void api<{ overview: Overview }>("/api/incidents/overview").then((res) => {
      if (live && res.ok) setOverview(res.data.overview);
    });
    return () => {
      live = false;
    };
  }, []);

  // The current template's categories and levels, then any other still on an existing incident (raised before the school switched template).
  const categoryOptions = useMemo<Option[]>(() => {
    const out = types.map((c) => ({ value: c.code, label: c.name }));
    for (const r of rows) if (!out.some((o) => o.value === r.incident_type)) out.push({ value: r.incident_type, label: r.incident_type });
    return out;
  }, [types, rows]);
  const severityOptions = useMemo<Option[]>(() => {
    const out = severities.map((s) => ({ value: s.slug, label: s.label }));
    for (const r of rows) if (!out.some((o) => o.value === r.severity)) out.push({ value: r.severity, label: r.severity });
    return out;
  }, [severities, rows]);
  const statusOptions = INCIDENT_STATUSES.map((s) => ({ value: s, label: tStatus(s) }));
  const flagOptions = INCIDENT_FLAGS.map((f) => ({ value: f, label: tFlag(f) }));

  const needsIds = useMemo(() => new Set(overview?.needsActionIds ?? []), [overview]);
  const overdueIds = useMemo(() => new Set(overview?.overdueIds ?? []), [overview]);
  const unackIds = useMemo(() => new Set(overview?.unacknowledgedIds ?? []), [overview]);
  const filtered = useMemo(
    () => applyFilters(rows, filters, { me: user?.id ?? null, involved, needsIds, overdueIds, unackIds }),
    [rows, filters, user?.id, involved, needsIds, overdueIds, unackIds],
  );
  const filtering = activeCount(filters) > 0;

  const [createOpen, setCreateOpen] = useState(false);
  const openIncident = (id: string) => router.push(`/incidents/${id}`);

  // ── bulk selection ──────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const prevFilteredRef = useRef(filtered);
  useEffect(() => {
    if (prevFilteredRef.current !== filtered) {
      setSelected(new Set());
      prevFilteredRef.current = filtered;
    }
  }, [filtered]);

  const bulkExportCsv = async () => {
    setBulkBusy(true);
    const res = await fetch("/api/incidents/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "export-csv", ids: [...selected] }),
    });
    setBulkBusy(false);
    if (!res.ok) { toast.error(td("bulk.error")); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `incidents-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const bulkAssignLead = async (leadId: string) => {
    setBulkBusy(true);
    const res = await fetch("/api/incidents/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "assign-lead", ids: [...selected], leadId }),
    });
    setBulkBusy(false);
    if (!res.ok) { toast.error(td("bulk.error")); return; }
    const { updated, skipped } = (await res.json()) as { updated: number; skipped: number };
    toast.success(td("bulk.assignedLead", { updated, skipped }));
    setSelected(new Set());
    void reload();
  };

  const bulkChangeStatus = async (status: string) => {
    setBulkBusy(true);
    const res = await fetch("/api/incidents/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "change-status", ids: [...selected], status }),
    });
    setBulkBusy(false);
    if (!res.ok) { toast.error(td("bulk.error")); return; }
    const { updated, skipped } = (await res.json()) as { updated: number; skipped: number };
    toast.success(td("bulk.changedStatus", { updated, skipped }));
    setSelected(new Set());
    void reload();
  };

  const handleMove = async (id: string, status: string) => {
    const undo = applyPatch(id, { status: status as never });
    const moveRes = await fetch(`/api/incidents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!moveRes.ok) {
      undo();
      // A move the school's requirements hold back comes with the reasons in plain words.
      const reason = moveRes.status === 409 ? ((await moveRes.json().catch(() => ({}))) as { error?: string }).error : null;
      toast.error(reason || t("moveFailed"));
      return;
    }
    void loadOverview();
  };

  const views: { key: DashboardView; label: string; icon: typeof List }[] = [
    { key: "board", label: tView("board"), icon: KanbanSquare },
    { key: "list", label: tView("list"), icon: List },
    ...(canPlay ? [{ key: "play" as const, label: td("viewPlay"), icon: HeartPulse }] : []),
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
            <ShieldAlert className="size-6 text-red-500" />
            {t("pageTitle")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("pageDesc")}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-border bg-muted/40 p-0.5" role="group" aria-label={tView("label")}>
            {views.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                aria-pressed={view === key}
                onClick={() => changeView(key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  view === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>
          <Button onClick={() => setCreateOpen(true)} className="bg-red-600 text-white hover:bg-red-700">
            <Plus className="size-4" />
            {t("raiseIncident")}
          </Button>
        </div>
      </div>

      {view === "play" ? (
        <div className="mt-4">
          <ClearancesScreen embedded />
        </div>
      ) : (
        <>
          {overview ? (
            <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat value={overview.open} label={td("stats.open")} active={filters.open} onClick={() => set({ open: !filters.open })} />
              <Stat value={overview.needsActionIds.length} label={td("stats.needs")} tone="warn" active={filters.needs} onClick={() => set({ needs: !filters.needs })} />
              <Stat value={overview.overdueSteps} label={td("stats.overdue")} tone="warn" active={filters.overdue} onClick={() => set({ overdue: !filters.overdue })} />
              <Stat value={overview.unacknowledged} label={td("stats.unacknowledged")} tone="warn" active={filters.unack} onClick={() => set({ unack: !filters.unack })} />
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2" role="search">
            <Input value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder={t("searchPlaceholder")} className="h-8 w-52 bg-card text-sm" />
            <Button
              variant="outline"
              size="sm"
              aria-pressed={filters.mine}
              onClick={() => set({ mine: !filters.mine })}
              className={cn("h-8 shrink-0", filters.mine && "border-primary text-primary")}
            >
              {td("mine")}
            </Button>
            <MultiFilter label={td("status")} options={statusOptions} selected={filters.status} onChange={(status) => set({ status })} />
            <MultiFilter label={td("category")} options={categoryOptions} selected={filters.category} onChange={(category) => set({ category })} />
            <MultiFilter label={td("severity")} options={severityOptions} selected={filters.severity} onChange={(severity) => set({ severity })} />
            <MultiFilter label={td("flag")} options={flagOptions} selected={filters.flag} onChange={(flag) => set({ flag })} />
            <select aria-label={td("lead")} className={fieldClass} value={filters.lead} onChange={(e) => set({ lead: e.target.value })}>
              <option value="">{td("anyLead")}</option>
              <option value={NO_LEAD}>{t("unassigned")}</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
            </select>
            <Input value={filters.student} onChange={(e) => set({ student: e.target.value })} placeholder={td("student")} aria-label={td("student")} className="h-8 w-40 bg-card text-sm" />
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              {td("from")}
              <input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} className={fieldClass} />
            </label>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              {td("to")}
              <input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} className={fieldClass} />
            </label>
            {filtering ? (
              <Button variant="ghost" size="sm" className="h-8" onClick={() => go({ ...filters, q: "", status: [], category: [], severity: [], flag: [], lead: "", mine: false, student: "", from: "", to: "", needs: false, open: false, overdue: false, unack: false })}>
                <X className="size-3.5" />
                {td("clear")}
              </Button>
            ) : null}
          </div>

          {!loading && !error ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
              <Filter className="size-3" />
              {td("count", { shown: filtered.length, total: rows.length })}
              {rows.length >= LIST_PAGE_SIZE ? ` ${td("newest", { count: LIST_PAGE_SIZE })}` : ""}
            </p>
          ) : null}

          {/* bulk action bar — only in list view when items are selected */}
          {view === "list" && selected.size > 0 && canManage ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-primary/5 px-4 py-2.5">
              <CheckSquare className="size-4 text-primary" />
              <span className="text-sm font-medium text-primary">{td("bulk.selected", { count: selected.size })}</span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" disabled={bulkBusy} onClick={() => void bulkExportCsv()}>
                  <Download className="size-3.5" />
                  {td("bulk.exportCsv")}
                </Button>
                <Popover>
                  <PopoverTrigger render={<Button variant="outline" size="sm" disabled={bulkBusy} />}>
                    <UserCheck className="size-3.5" />
                    {td("bulk.assignLead")}
                    <ChevronDown className="size-3" />
                  </PopoverTrigger>
                  <PopoverContent align="end" className="max-h-64 w-56 overflow-y-auto p-2">
                    <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">{td("bulk.assignLeadTitle")}</p>
                    {members.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => void bulkAssignLead(m.user_id)}
                        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        {m.full_name}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
                <Popover>
                  <PopoverTrigger render={<Button variant="outline" size="sm" disabled={bulkBusy} />}>
                    {td("bulk.changeStatus")}
                    <ChevronDown className="size-3" />
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-48 p-2">
                    <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">{td("bulk.changeStatusTitle")}</p>
                    {(["reported", "triaged", "contained", "investigating", "recovered"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => void bulkChangeStatus(s)}
                        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        {tStatus(s)}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                  <X className="size-3.5" />
                  {td("bulk.clear")}
                </Button>
              </div>
            </div>
          ) : null}

          <div className={cn("mt-3", view === "list" && "rounded-xl border border-border bg-card")}>
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="size-6 animate-spin text-primary" />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <p className="text-sm text-muted-foreground">{t("loadFailed")}</p>
                <Button variant="outline" size="sm" onClick={() => void reload()}>
                  {t("retry")}
                </Button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                <ShieldAlert className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{t("empty")}</p>
              </div>
            ) : view === "board" ? (
              <IncidentBoard rows={filtered} canManage={canManage} onOpen={openIncident} onMove={(id, s) => void handleMove(id, s)} />
            ) : (
              <IncidentListView
                rows={filtered}
                onOpen={openIncident}
                selected={canManage ? selected : undefined}
                onSelectChange={canManage ? setSelected : undefined}
              />
            )}
          </div>
        </>
      )}

      <RaiseIncidentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => void reload()}
        onOpenCreated={(id) => {
          router.push(`/incidents/${id}`);
        }}
      />
    </div>
  );
}
