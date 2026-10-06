"use client";

import { useTranslations } from "next-intl";

import type { FieldType } from "@/lib/sign/pdf/types";
import type { SignRole } from "@/lib/sign/types";
import { roleColorStyle } from "@/lib/sign/client/colors";
import { cn } from "@/lib/utils";

import { FIELD_ICONS, PALETTE_ORDER } from "./field-icons";
import { NativeSelect } from "./form-bits";
import { FIELD_DRAG_TYPE } from "./page-overlay";

interface PaletteProps {
  tool: FieldType | null;
  onTool: (type: FieldType | null) => void;
  roles: readonly SignRole[];
  activeRole: string | null;
  onActiveRole: (key: string) => void;
  disabled: boolean;
  full: boolean;
}

/** The field types, as buttons: choose one, then click or drag on a page. A type can also be dragged onto a page. */
export function Palette({ tool, onTool, roles, activeRole, onActiveRole, disabled, full }: PaletteProps) {
  const t = useTranslations("Sign.editor");
  const active = roles.find((r) => r.key === activeRole) ?? roles[0] ?? null;
  const hint = full ? t("palette.full") : tool ? t("palette.armed", { type: t(`types.${tool}`) }) : disabled ? "" : t("palette.hint");
  return (
    <div className="space-y-2 border-b bg-card px-3 py-2">
      {/* the first row is always there, so the page does not jump when the first role appears */}
      <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1">
        {roles.length > 0 ? (
          <div className="flex items-center gap-2" style={roleColorStyle(active ? active.color : 0)}>
            <label htmlFor="sign-active-role" className="text-xs font-medium text-muted-foreground">
              {t("palette.placeFor")}
            </label>
            <span aria-hidden className="size-2.5 rounded-full bg-[var(--rc-solid)]" />
            <NativeSelect id="sign-active-role" className="h-8 w-40" value={active?.key ?? ""} disabled={disabled} onChange={(e) => onActiveRole(e.target.value)}>
              {roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        <p className="min-w-0 flex-1 text-xs text-muted-foreground" aria-live="polite">
          {hint}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label={t("palette.label")}>
        {PALETTE_ORDER.map((type) => {
          const Icon = FIELD_ICONS[type];
          const on = tool === type;
          return (
            <button
              key={type}
              type="button"
              disabled={disabled || full}
              aria-pressed={on}
              draggable={!disabled && !full}
              onDragStart={(e) => {
                e.dataTransfer.setData(FIELD_DRAG_TYPE, type);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => onTool(on ? null : type)}
              title={t(`typeHints.${type}`)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
                on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-muted",
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {t(`types.${type}`)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
