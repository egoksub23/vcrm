"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { KanbanSquare, List, Loader2, Plus, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { useCapability } from "@/hooks/use-can";
import { useIncidents } from "@/hooks/use-incidents";
import { IncidentBoard } from "@/components/incidents/incident-board";
import { IncidentListView } from "@/components/incidents/incident-list-view";
import { RaiseIncidentDialog } from "@/components/incidents/raise-incident-dialog";
import { SEVERITY_STYLE } from "@/components/incidents/incident-visuals";
import { INCIDENT_SEVERITIES, type IncidentSeverity } from "@/lib/incidents/constants";

type ViewMode = "board" | "list";
const VIEW_STORAGE_KEY = "wacrm:incidents:view";

export default function IncidentsPage() {
  const t = useTranslations("Incidents.list");
  const tView = useTranslations("Incidents.view");
  const router = useRouter();
  const canManage = useCapability("incidents.manage");

  const { rows, loading, error, reload, applyPatch } = useIncidents();

  const [view, setView] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "board";
    try {
      return localStorage.getItem(VIEW_STORAGE_KEY) === "list" ? "list" : "board";
    } catch {
      return "board";
    }
  });
  const changeView = (next: ViewMode) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // storage blocked: the choice just is not remembered
    }
  };

  const [query, setQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<Set<IncidentSeverity>>(new Set());
  const toggleSeverity = (s: IncidentSeverity) =>
    setSeverityFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (severityFilter.size > 0 && !severityFilter.has(r.severity)) return false;
      if (q && !r.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, query, severityFilter]);

  const [createOpen, setCreateOpen] = useState(false);

  const openIncident = (id: string) => router.push(`/incidents/${id}`);

  const handleMove = async (id: string, status: string) => {
    const undo = applyPatch(id, { status: status as never });
    const { error: moveError } = await createClient().from("incidents").update({ status }).eq("id", id);
    if (moveError) {
      undo();
      toast.error(t("moveFailed"));
    }
  };

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
            {(["board", "list"] as const).map((v) => {
              const Icon = v === "board" ? KanbanSquare : List;
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => changeView(v)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" />
                  {tView(v)}
                </button>
              );
            })}
          </div>
          <Button onClick={() => setCreateOpen(true)} className="bg-red-600 text-white hover:bg-red-700">
            <Plus className="size-4" />
            {t("raiseIncident")}
          </Button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="h-8 w-56 bg-card text-sm"
        />
        {INCIDENT_SEVERITIES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={severityFilter.has(s)}
            onClick={() => toggleSeverity(s)}
            className={cn(
              "inline-flex h-8 items-center rounded-md border px-2.5 text-[12.5px] font-semibold outline-none transition-colors",
              severityFilter.has(s) ? SEVERITY_STYLE[s] : "border-border bg-card text-muted-foreground hover:bg-muted",
            )}
          >
            {s}
          </button>
        ))}
      </div>

      <div className={cn("mt-4", view === "list" && "rounded-xl border border-border bg-card")}>
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
          <IncidentListView rows={filtered} onOpen={openIncident} />
        )}
      </div>

      <RaiseIncidentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onOpenCreated={(id) => {
          router.push(`/incidents/${id}`);
        }}
      />
    </div>
  );
}
