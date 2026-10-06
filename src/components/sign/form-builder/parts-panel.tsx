"use client";

// The parts of the form, on the left: add, choose, reorder (drag, or the up and down buttons), delete, and the role
// each part belongs to (with the role's colour and name, so colour is never the only signal).

import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type DragEvent } from "react";

import { Button } from "@/components/ui/button";
import { roleColorStyle } from "@/lib/sign/client/colors";
import { MAX_PARTS } from "@/lib/sign/forms/types";
import { pick } from "@/lib/sign/forms/text";
import type { FormDefinition } from "@/lib/sign/forms/types";
import type { SignLocale, SignRole } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

export const PART_DRAG = "application/x-sign-form-part";
export const FIELD_DRAG = "application/x-sign-form-field";

interface PartsPanelProps {
  form: FormDefinition;
  roles: readonly SignRole[];
  lang: SignLocale;
  selected: string | null;
  readOnly: boolean;
  /** Parts that have a problem (by key). */
  issueParts: ReadonlySet<string>;
  onSelect: (key: string) => void;
  onAdd: () => void;
  onStep: (key: string, direction: -1 | 1) => void;
  onMove: (key: string, index: number) => void;
  onDelete: (key: string) => void;
  onDropField: (fieldKey: string, partKey: string) => void;
}

export function PartsPanel({ form, roles, lang, selected, readOnly, issueParts, onSelect, onAdd, onStep, onMove, onDelete, onDropField }: PartsPanelProps) {
  const t = useTranslations("Sign.formBuilder");
  const [over, setOver] = useState<string | null>(null);
  const count = (key: string) => form.fields.filter((f) => f.part === key).length;

  const onDrop = (e: DragEvent<HTMLLIElement>, key: string, index: number) => {
    setOver(null);
    const partKey = e.dataTransfer.getData(PART_DRAG);
    const fieldKey = e.dataTransfer.getData(FIELD_DRAG);
    if (partKey) {
      e.preventDefault();
      onMove(partKey, index);
    } else if (fieldKey) {
      e.preventDefault();
      onDropField(fieldKey, key);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-semibold">{t("parts.title")}</h2>
        <span className="text-xs text-muted-foreground">{form.parts.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {form.parts.length === 0 ? <p className="p-2 text-sm text-muted-foreground">{t("parts.empty")}</p> : null}
        <ul aria-label={t("parts.title")} className="space-y-1">
          {form.parts.map((part, i) => {
            const role = roles.find((r) => r.key === part.role);
            const isSelected = part.key === selected;
            return (
              <li
                key={part.key}
                onDragOver={(e) => {
                  if (readOnly) return;
                  if (e.dataTransfer.types.includes(PART_DRAG) || e.dataTransfer.types.includes(FIELD_DRAG)) {
                    e.preventDefault();
                    setOver(part.key);
                  }
                }}
                onDragLeave={() => setOver((o) => (o === part.key ? null : o))}
                onDrop={(e) => onDrop(e, part.key, i)}
                className={cn("rounded-lg border", isSelected ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted/60", over === part.key && "ring-2 ring-primary")}
              >
                <div
                  className="flex items-start gap-1 p-1.5"
                  draggable={!readOnly}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(PART_DRAG, part.key);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                >
                  <GripVertical className="mt-1 size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
                  <button type="button" aria-current={isSelected ? "true" : undefined} onClick={() => onSelect(part.key)} className="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="flex items-center gap-1 text-sm font-medium">
                      <span className="text-muted-foreground tabular-nums">{i + 1}</span>
                      <span className="truncate">{pick(part.title, lang) || t("parts.unnamed")}</span>
                      {issueParts.has(part.key) ? <TriangleAlert className="size-3.5 shrink-0 text-amber-600" aria-label={t("parts.hasIssue")} /> : null}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground" style={roleColorStyle(role ? role.color : null)}>
                      <span className="inline-flex items-center gap-1">
                        <span aria-hidden className="size-2 rounded-full bg-[var(--rc-solid)]" />
                        <span className={cn(!role && "text-destructive")}>{role ? role.label : t("parts.noRole")}</span>
                      </span>
                      <span>{t("parts.fieldCount", { count: count(part.key) })}</span>
                      {part.visibleIf ? <span>{t("parts.conditional")}</span> : null}
                    </span>
                  </button>
                </div>
                {readOnly ? null : (
                  <div className="flex justify-end gap-0.5 px-1.5 pb-1">
                    <Button type="button" variant="ghost" size="icon-xs" disabled={i === 0} aria-label={t("parts.up", { name: pick(part.title, lang) })} title={t("parts.up", { name: pick(part.title, lang) })} onClick={() => onStep(part.key, -1)}>
                      <ArrowUp />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-xs" disabled={i === form.parts.length - 1} aria-label={t("parts.down", { name: pick(part.title, lang) })} title={t("parts.down", { name: pick(part.title, lang) })} onClick={() => onStep(part.key, 1)}>
                      <ArrowDown />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={t("parts.delete", { name: pick(part.title, lang) })} title={t("parts.delete", { name: pick(part.title, lang) })} onClick={() => onDelete(part.key)}>
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {readOnly ? null : (
        <div className="space-y-1 border-t p-2">
          <Button type="button" variant="outline" size="sm" className="w-full" disabled={form.parts.length >= MAX_PARTS || roles.length === 0} onClick={onAdd}>
            <Plus />
            {t("parts.add")}
          </Button>
          {roles.length === 0 ? <p className="text-[11px] text-muted-foreground">{t("parts.needRole")}</p> : form.parts.length >= MAX_PARTS ? <p className="text-[11px] text-muted-foreground">{t("parts.max", { count: MAX_PARTS })}</p> : null}
        </div>
      )}
    </div>
  );
}
