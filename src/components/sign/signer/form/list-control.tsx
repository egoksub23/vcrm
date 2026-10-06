"use client";

// ============================================================
// Doc Sign, signing page, forms in parts: a list of entries (for example the business codes of a company).
// One input per entry; Enter adds a row below and moves to it; a button removes an entry. Empty entries are
// left out when the answer is saved, so a blank row costs nothing.
// ============================================================

import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatKey, listLimit } from "@/lib/sign/client/signer-form";

import { inputList, type ControlProps } from "./control-props";
import { useFormText } from "./form-ui";
import { SearchPicker } from "./search-picker";
import { RevealButton } from "./reveal-button";

/** `secret`: a sensitive list; the entries are hidden as they are typed, with one button to show them (sensitive-control.tsx). */
export function ListControl({ field, id, input, invalid, describedBy, onInput, onBlur, secret = false }: ControlProps & { secret?: boolean }) {
  const t = useTranslations("Sign.signerForm");
  const text = useFormText();
  const [shownSecret, setShownSecret] = useState(false);
  const rows = useRef<Array<HTMLInputElement | null>>([]);
  const entries = inputList(input);
  // entries picked from a shared list (the MSIC codes): a search box that adds one at a time, not free text
  if (field.options && field.options.length > 0) {
    return <SearchPicker id={id} options={field.options} mode="multi" selected={entries} onChange={(v) => onInput({ list: v })} onBlur={onBlur} invalid={invalid} describedBy={describedBy} label={text(field.label)} showCode max={listLimit(field)} />;
  }
  // always one row to type in
  const shown = entries.length > 0 ? entries : [""];
  const limit = listLimit(field);
  const format = formatKey(field.itemFormat);
  const digits = field.itemFormat === "digits" || field.itemFormat === "postcode_my";

  function set(index: number, value: string) {
    const next = [...shown];
    next[index] = value;
    onInput({ list: next });
  }

  /** Move the focus to a row once it exists (after the next render), unless the person has already gone elsewhere. */
  function focusRow(index: number) {
    const from = document.activeElement;
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (now === from || now === document.body || now === null) rows.current[index]?.focus();
    });
  }

  function add(after: number) {
    if (shown.length >= limit) return;
    const next = [...shown];
    next.splice(after + 1, 0, "");
    onInput({ list: next });
    focusRow(after + 1);
  }

  function remove(index: number) {
    onInput({ list: shown.filter((_, i) => i !== index) });
    focusRow(Math.max(0, index - 1));
  }

  const hints = [format ? t(`format.${format}`) : null, field.itemLength ? t("list.itemLength", { max: field.itemLength }) : null, t("list.limit", { max: limit })].filter(Boolean);

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {shown.map((entry, i) => (
          <li key={i} className="flex items-center gap-2">
            <Input
              id={i === 0 ? id : `${id}-${i}`}
              ref={(el) => {
                rows.current[i] = el;
              }}
              value={entry}
              type={secret && !shownSecret ? "password" : "text"}
              inputMode={digits ? "numeric" : "text"}
              autoComplete="off"
              maxLength={Math.min(field.itemLength ?? 100, 100)}
              placeholder={text(field.placeholder) || undefined}
              aria-label={t("list.entryLabel", { label: text(field.label), number: i + 1 })}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              enterKeyHint="next"
              className="h-11 min-w-0 flex-1 text-base"
              onChange={(e) => set(i, e.target.value)}
              onBlur={onBlur}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                // Enter adds a row; it must not submit or leave the part
                e.preventDefault();
                if (entry.trim() !== "") add(i);
              }}
            />
            {shown.length > 1 || entry !== "" ? (
              <Button type="button" variant="outline" className="size-11 shrink-0 p-0" aria-label={t("list.removeEntry", { number: i + 1 })} onClick={() => remove(i)}>
                <X className="size-4" aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Button type="button" variant="outline" className="h-11 px-3 text-base" disabled={shown.length >= limit || shown[shown.length - 1].trim() === ""} onClick={() => add(shown.length - 1)}>
          <Plus className="size-4" aria-hidden />
          {t("list.add")}
        </Button>
        {secret ? <RevealButton shown={shownSecret} onToggle={() => setShownSecret((v) => !v)} controls={id} label={text(field.label)} /> : null}
        <p className="text-xs text-muted-foreground">{hints.join(" · ")}</p>
      </div>
    </div>
  );
}
