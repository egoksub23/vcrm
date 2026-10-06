"use client";

// ============================================================
// Where the options of a choice, a multiple choice or a list of codes come from: typed here (the option editor), or a
// shared list kept in Settings > Doc Sign > Lists (states, countries, banks, MSIC codes ...). Naming a list puts a copy of its
// items into the field; the copy goes into the template version when it is saved and into each document when it is sent,
// so editing the list later changes no document that is already out. A list field (several codes) is either free text
// or picked from a list; it has no typed options.
// ============================================================

import { useState } from "react";
import { useTranslations } from "next-intl";

import { omit } from "@/lib/sign/client/form-edit";
import { loadList } from "@/lib/sign/client/lists-api";
import { listOptions, sameOptions } from "@/lib/sign/forms/lists";
import { pick } from "@/lib/sign/forms/text";
import type { DataField } from "@/lib/sign/forms/types";
import type { SignLocale } from "@/lib/sign/types";

import { FormRow, NativeSelect } from "./form-bits";
import { useListItems, useOptionLists } from "./use-option-lists";

interface ListSourceProps {
  field: DataField;
  lang: SignLocale;
  disabled?: boolean;
  onChange: (change: Partial<DataField> | ((f: DataField) => DataField), coalesceKey?: string) => void;
}

const PREVIEW_ROWS = 6;

export function ListSource({ field, lang, disabled, onChange }: ListSourceProps) {
  const t = useTranslations("Sign.formBuilder");
  const lists = useOptionLists();
  const k = field.key;
  const named = field.optionList;
  const items = useListItems(named);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // "A shared list" was chosen and no list has been picked yet
  const [picking, setPicking] = useState(false);
  const free = field.type === "list";

  const summary = lists.status === "ready" ? lists.lists.find((l) => l.key === named) : undefined;
  const unknown = named !== undefined && lists.status === "ready" && !summary;
  const stale = items.status === "ready" && named !== undefined && !sameOptions(field.options, listOptions(items.items));

  async function choose(key: string) {
    if (key === "") return;
    setBusy(true);
    setFailed(false);
    try {
      const { list } = await loadList(key);
      onChange({ optionList: key, options: listOptions(list.items) }, `list:${k}`);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  function switchToTyped() {
    // the copy stays as typed options a person can edit (a field with a list and no copy would have nothing to show)
    setPicking(false);
    onChange((f) => (free ? (omit(omit(f, "optionList"), "options") as DataField) : (omit(f, "optionList") as DataField)), `list:${k}`);
  }

  const mode = named !== undefined || picking ? "list" : "typed";
  const radio = (value: "typed" | "list", label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="radio"
        name={`source-${k}`}
        value={value}
        checked={mode === value}
        disabled={disabled}
        className="size-4 accent-[var(--primary)]"
        onChange={() => (value === "typed" ? switchToTyped() : setPicking(true))}
      />
      {label}
    </label>
  );

  const shown = (field.options ?? []).slice(0, PREVIEW_ROWS);

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-xs font-medium text-muted-foreground">{t("list.source")}</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        {radio("typed", free ? t("list.sourceFree") : t("list.sourceTyped"))}
        {radio("list", free ? t("list.sourcePicked") : t("list.sourceList"))}
      </div>

      {mode === "list" ? (
        <div className="space-y-2">
          <FormRow label={t("list.which")} htmlFor={`list-${k}`}>
            <NativeSelect id={`list-${k}`} value={named ?? ""} disabled={disabled || busy || lists.status !== "ready"} onChange={(e) => void choose(e.target.value)}>
              {named === undefined ? <option value="">{t("list.choose")}</option> : null}
              {named !== undefined && !summary ? <option value={named}>{named}</option> : null}
              {lists.status === "ready"
                ? lists.lists
                    .filter((l) => !l.archived || l.key === named)
                    .map((l) => (
                      <option key={l.key} value={l.key}>
                        {l.name} ({l.itemCount})
                      </option>
                    ))
                : null}
            </NativeSelect>
          </FormRow>
          {lists.status === "loading" ? <p className="text-[11px] text-muted-foreground">{t("list.loading")}</p> : null}
          {lists.status === "error" || failed ? (
            <p role="alert" className="text-[11px] text-destructive">
              {t("list.loadFailed")}
            </p>
          ) : null}
          {unknown ? (
            <p role="alert" className="text-[11px] text-destructive">
              {t("list.unknown", { key: named ?? "" })}
            </p>
          ) : null}
          {summary?.archived ? <p className="text-[11px] text-amber-700 dark:text-amber-400">{t("list.archived")}</p> : null}
          {stale ? <p className="text-[11px] text-amber-700 dark:text-amber-400">{t("list.stale")}</p> : null}
          {(field.options?.length ?? 0) > 0 ? (
            <div className="rounded-md border bg-muted/30 p-2">
              <p className="text-xs font-medium">{t("list.preview", { count: field.options?.length ?? 0 })}</p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {shown.map((o) => (
                  <li key={o.value} className="truncate">
                    {free ? <span className="mr-1.5 font-mono">{o.value}</span> : null}
                    {pick(o.label, lang) || o.value}
                  </li>
                ))}
                {(field.options?.length ?? 0) > PREVIEW_ROWS ? <li>{t("list.previewMore", { count: (field.options?.length ?? 0) - PREVIEW_ROWS })}</li> : null}
              </ul>
            </div>
          ) : null}
          <p className="text-[11px] text-muted-foreground">{free ? t("list.hintPicked") : t("list.hint")}</p>
        </div>
      ) : null}
    </fieldset>
  );
}
