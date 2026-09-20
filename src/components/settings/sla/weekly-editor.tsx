"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Copy, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
  MAX_SLOTS_PER_DAY,
  ISO_WEEKDAYS,
  formatHm,
  parseHm,
  type IsoWeekday,
  type Slot,
  type WeeklyHours,
} from "@/lib/sla/business-time";

// Per-day hours for one schedule: a switch per weekday (open / closed), up to
// four time slots a day, and "Copy hours to other days". A slot never crosses
// midnight; to be open until midnight type 00:00 as the end time (it is stored
// as 24:00). Overnight shifts are two slots (evening today, morning tomorrow).

const DEFAULT_SLOT: Slot = { start: "09:00", end: "18:00" };

/** "24:00" is shown (and typed) as 00:00 in a time input. */
const toInputEnd = (end: string) => (end === "24:00" ? "00:00" : end);
const fromInputEnd = (value: string, start: string) => (value === "00:00" && start !== "00:00" ? "24:00" : value);

/** A new slot after the last one: it starts where the last ends and lasts an hour (up to midnight). */
function nextSlot(slots: Slot[]): Slot {
  const last = slots[slots.length - 1];
  const startMin = Math.min(last ? (parseHm(last.end) ?? 540) : 540, 1439);
  return { start: formatHm(startMin), end: formatHm(Math.min(startMin + 60, 1440)) };
}

function dayName(locale: string, day: IsoWeekday): string {
  // 2024-01-01 is a Monday, so day 1..7 are Mon..Sun.
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, day)));
}

export function WeeklyEditor({
  value,
  onChange,
  disabled,
}: {
  value: WeeklyHours;
  onChange: (next: WeeklyHours) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("Settings.sla.hours");
  const locale = useLocale();
  const slotsOf = (day: IsoWeekday): Slot[] => value[String(day)] ?? [];
  const setDay = (day: IsoWeekday, slots: Slot[]) => onChange({ ...value, [String(day)]: slots });

  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {ISO_WEEKDAYS.map((day) => {
        const slots = slotsOf(day);
        const open = slots.length > 0;
        const name = dayName(locale, day);
        return (
          <li key={day} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start">
            <div className="flex w-full items-center gap-2 sm:w-40 sm:shrink-0 sm:pt-1">
              <Switch
                checked={open}
                disabled={disabled}
                aria-label={t("toggleDay", { day: name })}
                onCheckedChange={(on) => setDay(day, on ? [{ ...DEFAULT_SLOT }] : [])}
              />
              <span className="text-sm font-medium text-foreground">{name}</span>
            </div>

            <div className="min-w-0 flex-1 space-y-1.5">
              {!open ? (
                <p className="pt-1 text-sm text-muted-foreground">{t("closed")}</p>
              ) : (
                slots.map((slot, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1.5">
                    <input
                      type="time"
                      value={slot.start}
                      disabled={disabled}
                      aria-label={t("slotStart", { day: name, n: i + 1 })}
                      onChange={(e) =>
                        setDay(day, slots.map((s, j) => (j === i ? { ...s, start: e.target.value } : s)))
                      }
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:scheme-dark"
                    />
                    <span className="text-muted-foreground" aria-hidden>
                      –
                    </span>
                    <input
                      type="time"
                      value={toInputEnd(slot.end)}
                      disabled={disabled}
                      aria-label={t("slotEnd", { day: name, n: i + 1 })}
                      onChange={(e) =>
                        setDay(day, slots.map((s, j) => (j === i ? { ...s, end: fromInputEnd(e.target.value, s.start) } : s)))
                      }
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:scheme-dark"
                    />
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => setDay(day, slots.filter((_, j) => j !== i))}
                      aria-label={t("removeSlot", { day: name, n: i + 1 })}
                      title={t("removeSlot", { day: name, n: i + 1 })}
                      className="rounded p-1 text-muted-foreground hover:text-destructive disabled:opacity-50"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))
              )}
              {open ? (
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  {slots.length >= MAX_SLOTS_PER_DAY ? (
                    <span className="text-xs text-muted-foreground">{t("maxSlots", { count: MAX_SLOTS_PER_DAY })}</span>
                  ) : slots[slots.length - 1]?.end !== "24:00" ? (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => setDay(day, [...slots, nextSlot(slots)])}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
                    >
                      <Plus className="size-3" />
                      {t("addSlot")}
                    </button>
                  ) : null}
                  <CopyHours day={day} name={name} disabled={disabled} locale={locale} value={value} onChange={onChange} />
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** "Copy hours to other days": tick the days, press Copy. */
function CopyHours({
  day,
  name,
  disabled,
  locale,
  value,
  onChange,
}: {
  day: IsoWeekday;
  name: string;
  disabled?: boolean;
  locale: string;
  value: WeeklyHours;
  onChange: (next: WeeklyHours) => void;
}) {
  const t = useTranslations("Settings.sla.hours");
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<IsoWeekday>>(new Set());
  const others = ISO_WEEKDAYS.filter((d) => d !== day);
  const preset = (days: IsoWeekday[]) => setPicked(new Set(days.filter((d) => d !== day)));

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setPicked(new Set());
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
      >
        <Copy className="size-3" aria-hidden />
        {t("copyHours")}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <p className="text-xs font-medium text-foreground">{t("copyFrom", { day: name })}</p>
        <div className="flex flex-wrap gap-1">
          <button type="button" onClick={() => preset([1, 2, 3, 4, 5])} className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted">
            {t("copyWeekdays")}
          </button>
          <button type="button" onClick={() => preset([6, 7])} className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted">
            {t("copyWeekend")}
          </button>
          <button type="button" onClick={() => preset([...ISO_WEEKDAYS])} className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted">
            {t("copyAll")}
          </button>
        </div>
        <ul className="grid grid-cols-2 gap-x-2 gap-y-1">
          {others.map((d) => (
            <li key={d}>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={picked.has(d)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(d);
                    else next.delete(d);
                    setPicked(next);
                  }}
                />
                {dayName(locale, d)}
              </label>
            </li>
          ))}
        </ul>
        <Button
          size="sm"
          disabled={picked.size === 0}
          onClick={() => {
            const from = value[String(day)] ?? [];
            const next = { ...value };
            for (const d of picked) next[String(d)] = from.map((s) => ({ ...s }));
            onChange(next);
            setOpen(false);
            setPicked(new Set());
          }}
        >
          {t("copyApply")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
