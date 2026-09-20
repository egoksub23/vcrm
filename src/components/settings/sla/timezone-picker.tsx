"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronDown, Search } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const FALLBACK_ZONES = [
  "UTC",
  "Asia/Kuala_Lumpur",
  "Asia/Singapore",
  "Asia/Seoul",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/** Every IANA zone the browser knows (plus UTC), or a short list on very old engines. */
export function allTimezones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list && list.length > 0) return list.includes("UTC") ? list : ["UTC", ...list];
  } catch {
    // fall through to the short list
  }
  return FALLBACK_ZONES;
}

/** "GMT+8", "GMT-5:30" for a zone right now. */
export function offsetLabel(timezone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "shortOffset" }).formatToParts(at);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/**
 * A searchable timezone list (a popover with a filter box). The value is the
 * IANA name; the database checks it against pg_timezone_names, so a name the
 * browser knows but Postgres does not comes back as an error the screen shows.
 */
export function TimezonePicker({
  value,
  onChange,
  id,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  id?: string;
  disabled?: boolean;
}) {
  const t = useTranslations("Settings.sla.hours");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const zones = useMemo(() => allTimezones(), []);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, "_");
    const list = q ? zones.filter((z) => z.toLowerCase().includes(q)) : zones;
    return list.slice(0, 80);
  }, [zones, query]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        id={id}
        disabled={disabled}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-muted px-3 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
      >
        <span className="truncate">
          {value || t("timezonePlaceholder")}
          {value ? <span className="ml-2 text-xs text-muted-foreground">{offsetLabel(value)}</span> : null}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-2 p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("timezoneSearch")}
            aria-label={t("timezoneSearch")}
            className="h-8 w-full rounded-md border border-input bg-background pr-2 pl-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>
        <ul role="listbox" aria-label={t("timezone")} className="max-h-56 space-y-0.5 overflow-y-auto">
          {shown.length === 0 ? (
            <li className="px-2 py-3 text-center text-xs text-muted-foreground">{t("timezoneNone")}</li>
          ) : (
            shown.map((z) => (
              <li key={z} role="option" aria-selected={z === value}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(z);
                    setOpen(false);
                    setQuery("");
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                    z === value && "bg-primary-soft text-primary",
                  )}
                >
                  <span className="truncate">{z.replace(/_/g, " ")}</span>
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    {offsetLabel(z)}
                    {z === value ? <Check className="size-3.5 text-primary" aria-hidden /> : null}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
