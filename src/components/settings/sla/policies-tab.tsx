"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Loader2, Pencil, PlayCircle, Plus, ScrollText, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { SettingsChip } from "@/components/settings/settings-chip";
import { useTicketLabels } from "@/hooks/use-ticket-labels";
import { useTeams } from "@/hooks/use-teams";
import { splitMinutes } from "@/lib/sla/business-time";
import { orderedPolicies } from "@/lib/sla/policy";
import type { SlaPolicy, SlaSchedule } from "@/lib/sla/types";
import { PolicyDialog } from "./policy-dialog";
import { slaApi, type ApplyResult } from "./sla-api";

function useMinutesText() {
  const t = useTranslations("Settings.sla.policies.units");
  return (minutes: number): string => {
    const s = splitMinutes(minutes);
    return t(`short.${s.unit}`, { value: s.value });
  };
}

/** Settings > SLA & business hours > SLA policies: the ordered list, drag to reorder, apply to open tickets. */
export function PoliciesTab({
  policies,
  schedules,
  loading,
  reload,
}: {
  policies: SlaPolicy[];
  schedules: SlaSchedule[];
  loading: boolean;
  reload: () => Promise<void>;
}) {
  const t = useTranslations("Settings.sla.policies");
  const tErr = useTranslations("Settings.sla.errors");
  const { teams } = useTeams();
  const { labels } = useTicketLabels();
  const [editing, setEditing] = useState<SlaPolicy | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<SlaPolicy | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);

  // Optimistic order while the reorder call is in flight (cleared when the list reloads).
  const sorted = useMemo(() => orderedPolicies(policies), [policies]);
  const [override, setOverride] = useState<string[] | null>(null);
  const sortedKey = sorted.map((p) => `${p.id}:${p.position}`).join(",");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOverride(null);
  }, [sortedKey]);
  const shown = useMemo(() => {
    if (!override) return sorted;
    const byId = new Map(sorted.map((p) => [p.id, p]));
    return override.map((id) => byId.get(id)).filter((p): p is SlaPolicy => !!p);
  }, [sorted, override]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = shown.map((p) => p.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    setOverride(next);
    const result = await slaApi.reorderPolicies(next);
    if (!result.ok) {
      setOverride(null);
      toast.error(tErr(result.code));
      return;
    }
    await reload();
  };

  const toggleActive = async (p: SlaPolicy, on: boolean) => {
    setBusy(p.id);
    const result = await slaApi.updatePolicy(p.id, { is_active: on });
    setBusy(null);
    if (!result.ok) {
      toast.error(tErr(result.code));
      return;
    }
    await reload();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(deleting.id);
    const result = await slaApi.deletePolicy(deleting.id);
    setBusy(null);
    if (!result.ok) {
      toast.error(tErr(result.code));
      return;
    }
    toast.success(t("deleted"));
    setDeleting(null);
    await reload();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[62ch] text-sm text-muted-foreground">{t("intro")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setApplyOpen(true)} disabled={policies.length === 0}>
            <PlayCircle className="size-4" />
            {t("applyButton")}
          </Button>
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="size-4" />
            {t("new")}
          </Button>
        </div>
      </div>

      {loading && policies.length === 0 ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 px-6 py-10 text-center">
          <ScrollText className="size-8 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium text-foreground">{t("emptyTitle")}</p>
          <p className="max-w-[52ch] text-sm text-muted-foreground">{t("emptyHint")}</p>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t("orderHint")}</p>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void onDragEnd(e)}>
            <SortableContext items={shown.map((p) => p.id)} strategy={verticalListSortingStrategy}>
              <ol className="space-y-2">
                {shown.map((p, i) => (
                  <PolicyRow
                    key={p.id}
                    policy={p}
                    index={i}
                    scheduleName={schedules.find((s) => s.id === p.schedule_id)?.name ?? null}
                    teams={teams}
                    busy={busy === p.id}
                    onEdit={() => {
                      setEditing(p);
                      setDialogOpen(true);
                    }}
                    onDelete={() => setDeleting(p)}
                    onToggle={(on) => void toggleActive(p, on)}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        </>
      )}

      <PolicyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        policy={editing}
        schedules={schedules}
        teams={teams}
        knownLabels={labels.map((l) => l.label)}
        onSaved={() => void reload()}
      />

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle", { name: deleting?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("deleteHint")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" disabled={busy !== null} onClick={() => void confirmDelete()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ApplyDialog open={applyOpen} onOpenChange={setApplyOpen} />
    </div>
  );
}

function PolicyRow({
  policy,
  index,
  scheduleName,
  teams,
  busy,
  onEdit,
  onDelete,
  onToggle,
}: {
  policy: SlaPolicy;
  index: number;
  scheduleName: string | null;
  teams: { id: string; name: string }[];
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (on: boolean) => void;
}) {
  const t = useTranslations("Settings.sla.policies");
  const tCat = useTranslations("Tickets.detail.category");
  const tPri = useTranslations("Tickets.detail.priority");
  const tCh = useTranslations("Settings.sla.channels");
  const minutesText = useMinutesText();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: policy.id });

  const c = policy.conditions ?? {};
  const chips: string[] = [
    ...(c.priorities ?? []).map((p) => tPri(p as never)),
    ...(c.categories ?? []).map((x) => tCat(x as never)),
    ...(c.channels ?? []).map((x) => tCh(x as never)),
    ...(c.team_ids ?? []).map((id) => teams.find((tm) => tm.id === id)?.name ?? t("unknownTeam")),
    ...(c.labels ?? []).map((l) => `#${l}`),
  ];

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="flex flex-wrap items-start gap-3 rounded-xl border border-border bg-card p-3"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t("dragToReorder", { name: policy.name })}
        className="mt-0.5 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="size-4" />
      </button>
      <span className="mt-0.5 w-5 shrink-0 text-xs font-semibold text-muted-foreground tabular-nums">{index + 1}</span>

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-foreground">{policy.name}</h3>
          {!policy.is_active ? <SettingsChip variant="muted">{t("inactive")}</SettingsChip> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {chips.length === 0 ? t("matchesAll") : chips.join(" · ")}
        </p>
        <p className="text-sm text-foreground">
          {[
            policy.first_response_minutes !== null
              ? t("targetFirst", { time: minutesText(policy.first_response_minutes) })
              : null,
            policy.resolution_minutes !== null
              ? t("targetResolution", { time: minutesText(policy.resolution_minutes) })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <p className="text-xs text-muted-foreground">
          {scheduleName ? t("summarySchedule", { name: scheduleName }) : t("summaryAllHours")}
          {" · "}
          {policy.pause_while_pending ? t("summaryPauses") : t("summaryKeepsRunning")}
          {" · "}
          {t("summaryAtRisk", { percent: policy.at_risk_percent })}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          checked={policy.is_active}
          disabled={busy}
          aria-label={t("activeAria", { name: policy.name })}
          onCheckedChange={onToggle}
        />
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil className="size-3.5" />
          {t("edit")}
        </Button>
        <Button variant="outline" size="sm" onClick={onDelete} aria-label={t("deleteAria", { name: policy.name })}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

/** The confirmed, one-time "Apply to open tickets": a dry run first, then apply. */
function ApplyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("Settings.sla.policies.apply");
  const tErr = useTranslations("Settings.sla.errors");
  const [preview, setPreview] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreview(null);
    setError(null);
    void slaApi.applyToOpen(true).then((r) => {
      if (cancelled) return;
      if (r.ok) setPreview(r.data);
      else setError(tErr(r.code));
    });
    return () => {
      cancelled = true;
    };
  }, [open, tErr]);

  const apply = async () => {
    setApplying(true);
    const r = await slaApi.applyToOpen(false);
    setApplying(false);
    if (!r.ok) {
      setError(tErr(r.code));
      return;
    }
    toast.success(t("done", { count: r.data.matched }));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("hint")}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : preview === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("counting")}
          </div>
        ) : preview.matched === 0 ? (
          <p className="text-sm text-foreground">{t("none")}</p>
        ) : (
          <div className="space-y-1.5 text-sm text-foreground">
            <p>{t("willGet", { count: preview.matched })}</p>
            {preview.overdue > 0 ? <p>{t("overdue", { count: preview.overdue })}</p> : null}
            {preview.truncated ? <p className="text-xs text-muted-foreground">{t("truncated")}</p> : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            disabled={applying || preview === null || preview.matched === 0}
            onClick={() => void apply()}
          >
            {applying ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("confirm", { count: preview?.matched ?? 0 })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
