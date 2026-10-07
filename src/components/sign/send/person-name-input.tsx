"use client";

import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { contactLabel } from "./contact-picker";
import { useContactSearch, type ContactSummary } from "./use-contact-search";

interface Props {
  /** Id for the box, so a label can point at it. */
  id?: string;
  value: string;
  /** The name as it is typed. */
  onChange: (name: string) => void;
  /** A contact was chosen from the list: the parent fills the name and the email (the email stays editable). */
  onPickContact: (contact: ContactSummary) => void;
  disabled?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  maxLength?: number;
  onBlur?: () => void;
  className?: string;
}

/**
 * The full-name box of a person on a signing list, with a search of the workspace's contacts under it: typing a name that matches a contact offers
 * them, and choosing one fills the person in (the parent decides how). The same search and the same words as the contact picker. The name can
 * always be typed freely: a person who is not a contact is just typed.
 */
export function PersonNameInput({ id, value, onChange, onPickContact, disabled, readOnly, invalid, maxLength = 160, onBlur, className }: Props) {
  const t = useTranslations("Sign.send.contact");
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const typed = value.trim();
  // only look while the box is being used and has something typed (an empty box would list the newest contacts for no reason)
  const { rows, searching } = useContactSearch(typed, open && !disabled && !readOnly && typed.length > 0);
  const showList = open && typed.length > 0 && !disabled && !readOnly;
  const current = Math.min(active, Math.max(0, rows.length - 1));

  const pick = (c: ContactSummary) => {
    setOpen(false);
    onPickContact(c);
  };

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && rows[current] ? `${listId}-${current}` : undefined}
        aria-invalid={invalid}
        autoComplete="off"
        className={className}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        readOnly={readOnly}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setTimeout(() => setOpen(false), 120);
          onBlur?.();
        }}
        onChange={(e) => {
          setActive(0);
          setOpen(true);
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (!showList) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive(Math.min(rows.length - 1, current + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive(Math.max(0, current - 1));
          } else if (e.key === "Enter" && rows[current]) {
            e.preventDefault();
            pick(rows[current]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {showList && (searching || rows.length > 0) ? (
        <ul id={listId} role="listbox" aria-label={t("results")} className="absolute z-20 mt-1 max-h-64 w-full min-w-56 overflow-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {searching && rows.length === 0 ? (
            <li role="presentation" className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {t("searching")}
            </li>
          ) : (
            rows.map((c, i) => (
              <li
                key={c.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === current}
                className={cn("cursor-pointer rounded-md px-2 py-1.5", i === current && "bg-muted")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <p className="truncate text-sm font-medium">{contactLabel(c) || t("unnamed")}</p>
                <p className="truncate text-xs text-muted-foreground">{[c.email, c.phone, c.company].filter(Boolean).join(" · ")}</p>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
