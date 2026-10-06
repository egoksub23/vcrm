"use client";

// The pages as small outlines with their fields drawn in (no page images: cheap for 200 pages). Click to go there.

import { useTranslations } from "next-intl";
import { memo } from "react";

import { roleColorStyle } from "@/lib/sign/client/colors";
import { fieldsOnPage } from "@/lib/sign/client/editor-pages";
import type { PlacedField } from "@/lib/sign/pdf/types";
import { SENDER_ROLE } from "@/lib/sign/rules";
import type { SignRole } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

interface ThumbProps {
  index: number;
  count: number;
  aspect: number;
  fields: readonly PlacedField[];
  roles: readonly SignRole[];
  current: boolean;
  onGoto: (index: number) => void;
}

const ThumbImpl = memo(function Thumb({ index, count, aspect, fields, roles, current, onGoto }: ThumbProps) {
  const t = useTranslations("Sign.editor");
  const colorOf = (f: PlacedField) => {
    if (f.role === SENDER_ROLE) return null;
    return roles.find((r) => r.key === f.role)?.color ?? 0;
  };
  return (
    <button
      type="button"
      onClick={() => onGoto(index)}
      aria-current={current ? "page" : undefined}
      aria-label={t("pages.go", { page: index + 1, count })}
      className={cn("flex w-full flex-col items-center gap-1 rounded-lg p-1.5 outline-none [content-visibility:auto] [contain-intrinsic-size:auto_110px] hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50", current && "bg-muted")}
    >
      <span className={cn("relative block w-14 overflow-hidden rounded-[2px] bg-white ring-1", current ? "ring-2 ring-primary" : "ring-black/15")} style={{ aspectRatio: `1 / ${aspect}` }} aria-hidden>
        {fields.map((f) => (
          <span key={f.key} className="absolute block bg-[var(--rc-solid)] opacity-70" style={{ ...roleColorStyle(colorOf(f), "light"), left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }} />
        ))}
      </span>
      <span className="text-[11px] text-muted-foreground tabular-nums">
        {index + 1}
        {fields.length > 0 ? <span className="ml-1 rounded-full bg-primary/10 px-1 text-primary">{fields.length}</span> : null}
      </span>
    </button>
  );
});

interface PageListProps {
  pages: readonly { width: number; height: number }[];
  groups: ReadonlyMap<number, PlacedField[]>;
  roles: readonly SignRole[];
  current: number;
  onGoto: (index: number) => void;
}

export function PageList({ pages, groups, roles, current, onGoto }: PageListProps) {
  const t = useTranslations("Sign.editor");
  return (
    <nav aria-label={t("pages.label")} className="flex h-full flex-col items-center gap-0.5 overflow-y-auto p-1.5">
      {pages.map((p, i) => (
        <ThumbImpl key={i} index={i} count={pages.length} aspect={p.height / Math.max(1, p.width)} fields={fieldsOnPage(groups, i)} roles={roles} current={i === current} onGoto={onGoto} />
      ))}
    </nav>
  );
}
