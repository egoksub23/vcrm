"use client";

import { useTranslations } from "next-intl";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { TicketCustomValue, TicketFieldDefinition } from "@/types";

const NONE = "__none__";

interface TicketFieldInputProps {
  field: TicketFieldDefinition;
  value: TicketCustomValue | undefined;
  /** undefined clears the value. Text-like fields report every keystroke;
   *  callers that persist on change should debounce via `onCommit`. */
  onChange: (value: TicketCustomValue | undefined) => void;
  /** Fired when a text-like field loses focus, or immediately for
   *  dropdown/checkbox/date — the natural "save now" moment. */
  onCommit?: (value: TicketCustomValue | undefined) => void;
  disabled?: boolean;
  invalid?: boolean;
  idPrefix?: string;
}

/** One admin-defined ticket field, rendered for its type. Shared by the
 *  create dialog (values held locally until submit) and the detail sheet
 *  (each edit saved as it's committed). */
export function TicketFieldInput({
  field,
  value,
  onChange,
  onCommit,
  disabled,
  invalid,
  idPrefix = "ticket-field",
}: TicketFieldInputProps) {
  const t = useTranslations("Tickets.fields");
  const id = `${idPrefix}-${field.id}`;
  const inputClass = cn(invalid && "border-destructive focus-visible:ring-destructive/40");

  let control: React.ReactNode;
  switch (field.field_type) {
    case "textarea":
      control = (
        <textarea
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => onCommit?.(e.target.value)}
          rows={3}
          disabled={disabled}
          maxLength={2000}
          className={cn(
            "w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary/50 disabled:opacity-60",
            invalid && "border-destructive",
          )}
        />
      );
      break;
    case "number":
      control = (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          value={value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          onBlur={(e) => onCommit?.(e.target.value === "" ? undefined : Number(e.target.value))}
          disabled={disabled}
          className={inputClass}
        />
      );
      break;
    case "date":
      control = (
        <Input
          id={id}
          type="date"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => {
            const v = e.target.value || undefined;
            onChange(v);
            onCommit?.(v);
          }}
          disabled={disabled}
          className={inputClass}
        />
      );
      break;
    case "dropdown":
      control = (
        <Select
          value={typeof value === "string" && field.options.includes(value) ? value : NONE}
          onValueChange={(v) => {
            const next = !v || v === NONE ? undefined : v;
            onChange(next);
            onCommit?.(next);
          }}
          disabled={disabled}
        >
          <SelectTrigger id={id} className={cn("w-full bg-muted", invalid && "border-destructive")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t("noSelection")}</SelectItem>
            {field.options.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
      break;
    case "checkbox":
      control = (
        <div className="flex items-center gap-2 py-1">
          <Checkbox
            id={id}
            checked={value === true}
            onCheckedChange={(checked) => {
              const next = checked ? true : undefined;
              onChange(next);
              onCommit?.(next);
            }}
            disabled={disabled}
          />
          <span className="text-sm text-muted-foreground">{t("checkboxYes")}</span>
        </div>
      );
      break;
    default:
      control = (
        <Input
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => onCommit?.(e.target.value)}
          disabled={disabled}
          maxLength={500}
          className={inputClass}
        />
      );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-foreground">
        {field.label}
        {field.is_required && (
          <span className="text-destructive" aria-label={t("required")}>
            {" *"}
          </span>
        )}
      </Label>
      {control}
    </div>
  );
}
