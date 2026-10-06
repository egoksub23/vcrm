"use client";

// The data fields of the chosen part, in the middle: add a field of any type, drag or step them into order,
// duplicate or delete. Each row shows its type, whether it is required, the rule that shows it and how many
// places print it, so a whole part can be read without opening a field.

import { ArrowDown, ArrowUp, Copy, GripVertical, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type DragEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { MAX_DATA_FIELDS } from "@/lib/sign/forms/types";
import { pick } from "@/lib/sign/forms/text";
import { DATA_FIELD_TYPES, type DataField, type DataFieldType, type FormDefinition } from "@/lib/sign/forms/types";
import { cn } from "@/lib/utils";
import type { SignLocale } from "@/lib/sign/types";

import { FIELD_DRAG, PART_DRAG } from "./parts-panel";
import { DATA_TYPE_ICONS } from "./type-icons";
import { useRuleText } from "./use-rule-text";

interface FieldsPanelProps {
  form: FormDefinition;
  partKey: string;
  fields: DataField[];
  counts: ReadonlyMap<string, number>;
  lang: SignLocale;
  selected: string | null;
  readOnly: boolean;
  issueFields: ReadonlySet<string>;
  /** The part's name, role and settings, above the list. */
  header: ReactNode;
  onSelect: (key: string) => void;
  onAdd: (type: DataFieldType) => void;
  onStep: (key: string, direction: -1 | 1) => void;
  onMove: (key: string, index: number) => void;
  onDuplicate: (key: string) => void;
  onDelete: (key: string) => void;
}

export function FieldsPanel({ form, partKey, fields, counts, lang, selected, readOnly, issueFields, header, onSelect, onAdd, onStep, onMove, onDuplicate, onDelete }: FieldsPanelProps) {
  const t = useTranslations("Sign.formBuilder");
  const ruleText = useRuleText(form, lang);
  const [picking, setPicking] = useState(false);
  const [over, setOver] = useState<number | null>(null);
  const full = form.fields.length >= MAX_DATA_FIELDS;

  const onDrop = (e: DragEvent<HTMLElement>, index: number) => {
    setOver(null);
    const key = e.dataTransfer.getData(FIELD_DRAG);
    if (!key) return;
    e.preventDefault();
    onMove(key, index);
  };
  const acceptsField = (e: DragEvent<HTMLElement>) => !readOnly && e.dataTransfer.types.includes(FIELD_DRAG) && !e.dataTransfer.types.includes(PART_DRAG);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {header}
        {fields.length === 0 ? <p className="p-2 text-sm text-muted-foreground">{t("fields.empty")}</p> : null}
        <ul aria-label={t("fields.title")} className="space-y-1">
          {fields.map((f, i) => {
            const Icon = DATA_TYPE_ICONS[f.type];
            const places = counts.get(f.key) ?? 0;
            const isSelected = f.key === selected;
            const label = pick(f.label, lang) || t("props.unnamed");
            const rule = f.visibleIf ? ruleText(f.visibleIf) : "";
            return (
              <li
                key={f.key}
                onDragOver={(e) => {
                  if (acceptsField(e)) {
                    e.preventDefault();
                    setOver(i);
                  }
                }}
                onDragLeave={() => setOver((o) => (o === i ? null : o))}
                onDrop={(e) => onDrop(e, i)}
                className={cn("rounded-lg border bg-card", isSelected ? "border-primary ring-1 ring-primary/40" : "hover:bg-muted/40", over === i && "ring-2 ring-primary")}
              >
                <div
                  className="flex items-start gap-1 p-1.5"
                  draggable={!readOnly}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(FIELD_DRAG, f.key);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                >
                  <GripVertical className="mt-1 size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
                  <button type="button" aria-current={isSelected ? "true" : undefined} onClick={() => onSelect(f.key)} className="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="flex items-center gap-1.5">
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate text-sm font-medium">{label}</span>
                      {issueFields.has(f.key) ? <TriangleAlert className="size-3.5 shrink-0 text-amber-600" aria-label={t("fields.hasIssue")} /> : null}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                      <span className="rounded bg-muted px-1.5 py-0.5">{t(`types.${f.type}`)}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5">{f.required || f.type === "acknowledge" ? t("fields.required") : f.requiredIf ? t("fields.requiredSometimes") : t("fields.optional")}</span>
                      {rule ? (
                        <span className="max-w-full truncate rounded bg-primary/10 px-1.5 py-0.5 text-primary" title={rule}>
                          {t("fields.showIf", { rule })}
                        </span>
                      ) : null}
                      {f.type === "file" ? null : <span className={cn("rounded px-1.5 py-0.5", places > 0 ? "bg-muted" : "bg-muted/50")}>{places > 0 ? t("fields.places", { count: places }) : t("fields.notPrinted")}</span>}
                      {f.contactField ? <span className="rounded bg-muted px-1.5 py-0.5">{t("fields.fillsContact")}</span> : null}
                    </span>
                  </button>
                  {readOnly ? null : (
                    <div className="flex shrink-0 gap-0.5">
                      <Button type="button" variant="ghost" size="icon-xs" disabled={i === 0} aria-label={t("fields.up", { name: label })} title={t("fields.up", { name: label })} onClick={() => onStep(f.key, -1)}>
                        <ArrowUp />
                      </Button>
                      <Button type="button" variant="ghost" size="icon-xs" disabled={i === fields.length - 1} aria-label={t("fields.down", { name: label })} title={t("fields.down", { name: label })} onClick={() => onStep(f.key, 1)}>
                        <ArrowDown />
                      </Button>
                      <Button type="button" variant="ghost" size="icon-xs" disabled={full} aria-label={t("fields.duplicate", { name: label })} title={t("fields.duplicate", { name: label })} onClick={() => onDuplicate(f.key)}>
                        <Copy />
                      </Button>
                      <Button type="button" variant="ghost" size="icon-xs" aria-label={t("fields.delete", { name: label })} title={t("fields.delete", { name: label })} onClick={() => onDelete(f.key)}>
                        <Trash2 />
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {/* dropping below the last row puts a field at the end */}
        {fields.length > 0 && !readOnly ? (
          <div
            className={cn("mt-1 h-6 rounded-md", over === fields.length && "bg-primary/20")}
            onDragOver={(e) => {
              if (acceptsField(e)) {
                e.preventDefault();
                setOver(fields.length);
              }
            }}
            onDragLeave={() => setOver((o) => (o === fields.length ? null : o))}
            onDrop={(e) => onDrop(e, fields.length)}
            aria-hidden
          />
        ) : null}
      </div>
      {readOnly ? null : (
        <div className="space-y-2 border-t p-2">
          <Button type="button" variant="outline" size="sm" aria-expanded={picking} disabled={full || !form.parts.some((p) => p.key === partKey)} onClick={() => setPicking((v) => !v)}>
            <Plus />
            {t("fields.add")}
          </Button>
          {full ? <p className="text-[11px] text-muted-foreground">{t("fields.max", { count: MAX_DATA_FIELDS })}</p> : null}
          {picking && !full ? (
            <ul aria-label={t("fields.pickType")} className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {DATA_FIELD_TYPES.map((type) => {
                const Icon = DATA_TYPE_ICONS[type];
                return (
                  <li key={type}>
                    <button
                      type="button"
                      title={t(`typeHints.${type}`)}
                      onClick={() => {
                        setPicking(false);
                        onAdd(type);
                      }}
                      className="flex h-8 w-full items-center gap-1.5 rounded-lg border bg-background px-2 text-xs font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Icon className="size-3.5 shrink-0" aria-hidden />
                      <span className="truncate">{t(`types.${type}`)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}
