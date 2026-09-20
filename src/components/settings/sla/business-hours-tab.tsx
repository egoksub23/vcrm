"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarClock, Globe2, Loader2, Pencil, Plus, Star, Trash2 } from "lucide-react";
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
import { SettingsChip } from "@/components/settings/settings-chip";
import type { IsoWeekday } from "@/lib/sla/business-time";
import { summarizeWeekly } from "@/lib/sla/summary";
import type { SlaErrorCode, SlaSchedule } from "@/lib/sla/types";
import { ScheduleEditorDialog } from "./schedule-editor";
import { slaApi } from "./sla-api";
import { offsetLabel } from "./timezone-picker";

function shortDay(locale: string, day: IsoWeekday): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, day)));
}

/** Settings > SLA & business hours > Business hours: the list of schedules and the editor. */
export function BusinessHoursTab({
  schedules,
  policyCountBySchedule,
  loading,
  reload,
}: {
  schedules: SlaSchedule[];
  /** How many policies use each schedule (the delete is blocked while it is above zero). */
  policyCountBySchedule: Map<string, number>;
  loading: boolean;
  reload: () => Promise<void>;
}) {
  const t = useTranslations("Settings.sla.hours");
  const tErr = useTranslations("Settings.sla.errors");
  const locale = useLocale();
  const [editing, setEditing] = useState<SlaSchedule | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleting, setDeleting] = useState<SlaSchedule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<SlaErrorCode | null>(null);

  const openNew = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const openEdit = (s: SlaSchedule) => {
    setEditing(s);
    setEditorOpen(true);
  };

  const makeDefault = async (s: SlaSchedule) => {
    setBusy(s.id);
    const result = await slaApi.updateSchedule(s.id, { is_default: true });
    setBusy(null);
    if (!result.ok) {
      toast.error(tErr(result.code));
      return;
    }
    toast.success(t("defaultSet", { name: s.name }));
    await reload();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(deleting.id);
    const result = await slaApi.deleteSchedule(deleting.id);
    setBusy(null);
    if (!result.ok) {
      setDeleteError(result.code);
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
        <Button onClick={openNew}>
          <Plus className="size-4" />
          {t("new")}
        </Button>
      </div>

      {loading && schedules.length === 0 ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : schedules.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 px-6 py-10 text-center">
          <CalendarClock className="size-8 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium text-foreground">{t("emptyTitle")}</p>
          <p className="max-w-[52ch] text-sm text-muted-foreground">{t("emptyHint")}</p>
          <Button className="mt-1" onClick={openNew}>
            <Plus className="size-4" />
            {t("new")}
          </Button>
        </div>
      ) : (
        <ul className="space-y-3">
          {schedules.map((s) => {
            const groups = summarizeWeekly(s.weekly);
            const used = policyCountBySchedule.get(s.id) ?? 0;
            return (
              <li key={s.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-foreground">{s.name}</h3>
                      {s.is_default ? (
                        <SettingsChip variant="ok">
                          <Star aria-hidden />
                          {t("default")}
                        </SettingsChip>
                      ) : null}
                    </div>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Globe2 className="size-3.5" aria-hidden />
                      {s.timezone.replace(/_/g, " ")} <span>({offsetLabel(s.timezone)})</span>
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {!s.is_default ? (
                      <Button variant="outline" size="sm" disabled={busy === s.id} onClick={() => void makeDefault(s)}>
                        {t("makeDefaultButton")}
                      </Button>
                    ) : null}
                    <Button variant="outline" size="sm" onClick={() => openEdit(s)}>
                      <Pencil className="size-3.5" />
                      {t("edit")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setDeleteError(used > 0 ? "schedule_in_use" : null);
                        setDeleting(s);
                      }}
                      aria-label={t("deleteAria", { name: s.name })}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>

                <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-4">
                  {groups.length === 0 ? (
                    <dd className="text-muted-foreground">{t("closed")}</dd>
                  ) : (
                    groups.map((g) => (
                      <div key={g.from} className="contents">
                        <dt className="text-muted-foreground">
                          {g.from === g.to ? shortDay(locale, g.from) : `${shortDay(locale, g.from)}–${shortDay(locale, g.to)}`}
                        </dt>
                        <dd className="text-foreground">{g.hours.replace(/-/g, "–")}</dd>
                      </div>
                    ))
                  )}
                </dl>

                <p className="mt-3 text-xs text-muted-foreground">
                  {t("holidayCount", { count: s.holidays.length })} · {t("policyCount", { count: used })}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      <ScheduleEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        schedule={editing}
        onSaved={() => void reload()}
      />

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle", { name: deleting?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("deleteHint")}</DialogDescription>
          </DialogHeader>
          {deleteError ? (
            <p role="alert" className="text-sm text-destructive">
              {tErr(deleteError)}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy !== null || deleteError === "schedule_in_use"}
              onClick={() => void confirmDelete()}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
