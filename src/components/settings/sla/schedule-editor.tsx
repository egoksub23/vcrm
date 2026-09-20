"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { CalendarPlus, Loader2, Trash2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MON_FRI_9_TO_18, emptyWeekly, type WeeklyHours } from "@/lib/sla/business-time";
import { validateHolidayPayload, validateSchedulePayload } from "@/lib/sla/policy";
import type { SlaErrorCode, SlaSchedule } from "@/lib/sla/types";
import { slaApi, type HolidayDraft } from "./sla-api";
import { TimezonePicker } from "./timezone-picker";
import { WeeklyEditor } from "./weekly-editor";

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Create or edit one business-hours schedule: name, timezone, weekly hours with
 * time slots, holidays (whole closed days) and "Make default". Everything saves
 * together with one button; `schedule` null creates.
 */
export function ScheduleEditorDialog({
  open,
  onOpenChange,
  schedule,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule: SlaSchedule | null;
  onSaved: () => void;
}) {
  // Reset the draft whenever the dialog opens on a different schedule.
  const key = open ? (schedule?.id ?? "new") : "closed";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        {open ? <ScheduleEditor key={key} schedule={schedule} onClose={() => onOpenChange(false)} onSaved={onSaved} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** The dialog body (exported for the render tests). */
export function ScheduleEditor({
  schedule,
  onClose,
  onSaved,
}: {
  schedule: SlaSchedule | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("Settings.sla.hours");
  const tErr = useTranslations("Settings.sla.errors");
  const format = useFormatter();

  const [name, setName] = useState(schedule?.name ?? "");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? browserTimezone());
  const [weekly, setWeekly] = useState<WeeklyHours>(schedule?.weekly ?? emptyWeekly());
  const [holidays, setHolidays] = useState<HolidayDraft[]>(
    () => (schedule?.holidays ?? []).map((h) => ({ date: h.holiday_date, name: h.name })),
  );
  const [makeDefault, setMakeDefault] = useState(false);
  const [newDate, setNewDate] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<SlaErrorCode | null>(null);
  const [saving, setSaving] = useState(false);

  const isDefault = schedule?.is_default ?? false;

  const addHoliday = () => {
    const checked = validateHolidayPayload({ date: newDate, name: newName });
    if (!checked.ok) {
      setError(checked.code);
      return;
    }
    if (holidays.some((h) => h.date === checked.value.holiday_date)) {
      setError("duplicate_holiday");
      return;
    }
    setError(null);
    setHolidays([...holidays, { date: checked.value.holiday_date, name: checked.value.name }].sort((a, b) => a.date.localeCompare(b.date)));
    setNewDate("");
    setNewName("");
  };

  const save = async () => {
    const checked = validateSchedulePayload({ name, timezone, weekly }, false);
    if (!checked.ok) {
      setError(checked.code);
      return;
    }
    setError(null);
    setSaving(true);
    const body = {
      name: checked.value.name!,
      timezone: checked.value.timezone!,
      weekly: checked.value.weekly!,
      holidays,
      ...(makeDefault && !isDefault ? { is_default: true } : {}),
    };
    const result = schedule ? await slaApi.updateSchedule(schedule.id, body) : await slaApi.createSchedule(body);
    setSaving(false);
    if (!result.ok) {
      setError(result.code);
      return;
    }
    toast.success(t("saved"));
    onSaved();
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{schedule ? t("editTitle") : t("newTitle")}</DialogTitle>
        <DialogDescription>{t("editorHint")}</DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sla-sched-name" className="text-foreground">
              {t("name")}
            </Label>
            <Input
              id="sla-sched-name"
              value={name}
              maxLength={80}
              placeholder={t("namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
              className="bg-muted"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sla-sched-tz" className="text-foreground">
              {t("timezone")}
            </Label>
            <TimezonePicker id="sla-sched-tz" value={timezone} onChange={setTimezone} />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground">{t("weekly")}</p>
            <Button variant="outline" size="sm" onClick={() => setWeekly({ ...MON_FRI_9_TO_18 })}>
              {t("presetMonFri")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("weeklyHint")}</p>
          <WeeklyEditor value={weekly} onChange={setWeekly} />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{t("holidays")}</p>
          <p className="text-xs text-muted-foreground">{t("holidaysHint")}</p>
          {holidays.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noHolidays")}</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {holidays.map((h) => (
                <li key={h.date} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-foreground">
                      {format.dateTime(new Date(`${h.date}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" })}
                    </span>
                    {h.name ? <span className="ml-2 text-muted-foreground">{h.name}</span> : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => setHolidays(holidays.filter((x) => x.date !== h.date))}
                    aria-label={t("removeHoliday", { name: h.name || h.date })}
                    title={t("removeHoliday", { name: h.name || h.date })}
                    className="rounded p-1 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="sla-hol-date" className="text-xs text-muted-foreground">
                {t("holidayDate")}
              </Label>
              <input
                id="sla-hol-date"
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                className="h-9 rounded-md border border-input bg-muted px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:scheme-dark"
              />
            </div>
            <div className="min-w-40 flex-1 space-y-1">
              <Label htmlFor="sla-hol-name" className="text-xs text-muted-foreground">
                {t("holidayName")}
              </Label>
              <Input
                id="sla-hol-name"
                value={newName}
                maxLength={80}
                placeholder={t("holidayNamePlaceholder")}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addHoliday();
                  }
                }}
                className="bg-muted"
              />
            </div>
            <Button variant="outline" onClick={addHoliday} disabled={!newDate}>
              <CalendarPlus className="size-4" />
              {t("addHoliday")}
            </Button>
          </div>
        </div>

        {!isDefault ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
            {t("makeDefault")}
          </label>
        ) : (
          <p className="text-xs text-muted-foreground">{t("isDefaultHint")}</p>
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {tErr(error)}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          {t("cancel")}
        </Button>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {schedule ? t("save") : t("create")}
        </Button>
      </DialogFooter>
    </>
  );
}
