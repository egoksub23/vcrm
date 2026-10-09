"use client";

// ============================================================
// Secure Sign, step 3: the pieces of the LEFT column. Who a new block is for (the people who must sign, each a coloured chip with the name and the
// address under it), a quick "Add a signature block for <name>" for each of them with how many blocks they have (in all, and in the document in
// view), and the field types to place. The properties of the selected block and the lists sit under these (the editor composes them).
// ============================================================

import { PenLine } from "lucide-react";
import { useTranslations } from "next-intl";
import type { KeyboardEvent } from "react";

import { PaletteTypes } from "@/components/sign/editor/palette";
import { ROLE_CLASS, roleColorStyle } from "@/lib/sign/client/colors";
import type { FieldType } from "@/lib/sign/pdf/types";
import { cn } from "@/lib/utils";

export interface PersonRow {
  key: string;
  /** As typed ("" when not yet): the selector shows "Person N" then. */
  name: string;
  email: string;
  color: number;
  /** Signature blocks over all the documents. */
  total: number;
  /** Signature blocks in the document in view. */
  here: number;
  /** Something can be added for them in the document in view (they have a place on it, and it can be changed). */
  canAdd: boolean;
}

interface SelectorProps {
  people: readonly PersonRow[];
  activeKey: string | null;
  onActive: (key: string) => void;
  onAdd: (key: string) => void;
  /** Nothing can be changed (read only, a phone, nothing to place on). */
  disabled: boolean;
  personName: (index: number) => string;
}

/** Who new blocks are for: a radio group of the people who must sign, each with a button that puts a signature block for them on the page in view. */
export function PersonSelector({ people, activeKey, onActive, onAdd, disabled, personName }: SelectorProps) {
  const t = useTranslations("Sign.process.multi");
  const active = people.find((p) => p.key === activeKey)?.key ?? people[0]?.key ?? null;
  const move = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = e.key === "ArrowDown" || e.key === "ArrowRight" ? (i + 1) % people.length : e.key === "ArrowUp" || e.key === "ArrowLeft" ? (i + people.length - 1) % people.length : -1;
    if (next < 0) return;
    e.preventDefault();
    onActive(people[next].key);
    document.getElementById(`blocks-person-${people[next].key}`)?.focus();
  };
  if (people.length === 0) return <p className="text-sm text-muted-foreground">{t("noPeople")}</p>;
  return (
    <div role="radiogroup" aria-label={t("whoLabel")} className="space-y-2" data-person-selector>
      {people.map((p, i) => {
        const on = p.key === active;
        const name = p.name || personName(i);
        return (
          <div key={p.key} data-person={p.key} data-blocks={p.total} style={roleColorStyle(p.color)} className={cn("rounded-lg border bg-background", on ? "border-[color:var(--rc-solid)] ring-1 ring-[color:var(--rc-solid)]" : "border-border")}>
            <button
              id={`blocks-person-${p.key}`}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              disabled={disabled}
              onClick={() => onActive(p.key)}
              onKeyDown={(e) => move(e, i)}
              className="flex w-full items-start gap-2 rounded-t-lg px-2.5 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className={cn("mt-1 size-2.5 shrink-0 rounded-full", ROLE_CLASS.dot)} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">{name}</span>
                {p.email ? (
                  <span data-chip-email className="block truncate text-xs text-muted-foreground">
                    {p.email}
                  </span>
                ) : null}
                <span className={cn("block text-xs", p.total > 0 ? "text-muted-foreground" : "text-[light-dark(#92400e,#fcd34d)]")}>{t("countsLine", { total: p.total, here: p.here })}</span>
              </span>
            </button>
            <button
              type="button"
              disabled={disabled || !p.canAdd}
              data-quick-role={p.key}
              data-blocks={p.total}
              onClick={() => onAdd(p.key)}
              className={cn("flex w-full items-center gap-1.5 rounded-b-lg border-t px-2.5 py-1.5 text-left text-xs font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50", "border-[color:var(--rc-solid)] bg-[var(--rc-fill)] text-[var(--rc-text)] hover:brightness-95")}
            >
              <PenLine className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{t("addSignatureFor", { name })}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

interface PaletteProps {
  tool: FieldType | null;
  onTool: (type: FieldType | null) => void;
  disabled: boolean;
  full: boolean;
}

/** The field types as a grid of buttons, with the hint for the one armed. */
export function ToolPalette({ tool, onTool, disabled, full }: PaletteProps) {
  const te = useTranslations("Sign.editor");
  const hint = full ? te("palette.full") : tool ? te("palette.armed", { type: te(`types.${tool}`) }) : disabled ? "" : te("palette.hint");
  return (
    <div className="space-y-2" data-tool-palette>
      <PaletteTypes tool={tool} onTool={onTool} disabled={disabled} full={full} className="grid grid-cols-2 gap-1" buttonClassName="w-full justify-start" />
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {hint}
      </p>
    </div>
  );
}
