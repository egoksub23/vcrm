"use client";

import { Check, ImageUp, Link2, TriangleAlert } from "lucide-react";

import type { Sample } from "@/lib/sign/client/editor-preview";
import type { PlacedField } from "@/lib/sign/pdf/types";
import { cn } from "@/lib/utils";

import { FIELD_ICONS } from "./field-icons";

const SCRIPT_FONT = '"Segoe Script", "Brush Script MT", "Snell Roundhand", "Apple Chancery", cursive';

const justify = { left: "justify-start text-left", center: "justify-center text-center", right: "justify-end text-right" } as const;

export interface FieldVisualProps {
  field: PlacedField;
  /** What the box says in the editor: the label, the type, or the merge value. */
  caption: string;
  /** The name of the role, or of the sender. */
  roleLabel: string;
  /** Size of the box on screen, in CSS pixels. */
  widthPx: number;
  heightPx: number;
  /** CSS pixels per point of the page (the zoom). */
  pxPerPt: number;
  /** In preview, what the field would show. Null in the editor. */
  sample: Sample | null;
  hasIssue: boolean;
  /** Forms: the label of the data field this placement prints; the box then shows it as a badge. */
  dataLabel?: string;
}

/** The inside of a field box: the editor's icon and label, or the preview's sample value. */
export function FieldVisual({ field, caption, roleLabel, widthPx, heightPx, pxPerPt, sample, hasIssue, dataLabel }: FieldVisualProps) {
  const align = field.align ?? "left";
  if (sample) return <PreviewContent field={field} sample={sample} widthPx={widthPx} heightPx={heightPx} pxPerPt={pxPerPt} align={align} />;

  const Icon = FIELD_ICONS[field.type];
  const iconOnly = widthPx < 54 || heightPx < 16;
  if (dataLabel !== undefined) {
    return (
      <div className={cn("flex h-full w-full min-w-0 items-center overflow-hidden px-0.5", iconOnly && "justify-center")} aria-hidden>
        {hasIssue ? <TriangleAlert className="mr-0.5 size-3 shrink-0 text-destructive" /> : null}
        <span data-data-badge className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-[3px] bg-[var(--rc-solid)] px-1 py-0.5 text-[10px] leading-none font-medium text-white">
          <Link2 className="size-3 shrink-0" />
          {iconOnly ? null : <span className="truncate">{dataLabel}</span>}
        </span>
      </div>
    );
  }
  const showRole = !iconOnly && heightPx >= 34;
  return (
    <div className="flex h-full w-full min-w-0 flex-col justify-center overflow-hidden px-1 leading-tight" aria-hidden>
      <div className={cn("flex min-w-0 items-center gap-1", iconOnly && "justify-center")}>
        {hasIssue ? <TriangleAlert className="size-3 shrink-0 text-destructive" /> : null}
        <Icon className={cn("shrink-0", iconOnly ? "size-3" : "size-3.5")} />
        {iconOnly ? null : <span className="truncate text-[11px] font-medium">{caption}</span>}
      </div>
      {showRole ? <span className="truncate text-[10px] opacity-80">{roleLabel}</span> : null}
    </div>
  );
}

function PreviewContent({ field, sample, widthPx, heightPx, pxPerPt, align }: { field: PlacedField; sample: Sample; widthPx: number; heightPx: number; pxPerPt: number; align: "left" | "center" | "right" }) {
  if (sample.kind === "check") {
    return (
      <div className="flex h-full w-full items-center justify-center" aria-hidden>
        <Check style={{ width: Math.max(8, Math.min(widthPx, heightPx) * 0.8), height: Math.max(8, Math.min(widthPx, heightPx) * 0.8) }} />
      </div>
    );
  }
  if (sample.kind === "image") {
    return (
      <div className="flex h-full w-full items-center justify-center opacity-60" aria-hidden>
        <ImageUp style={{ width: Math.max(8, Math.min(widthPx, heightPx) * 0.5), height: Math.max(8, Math.min(widthPx, heightPx) * 0.5) }} />
      </div>
    );
  }
  const script = sample.kind === "script";
  const auto = Math.max(7, Math.min(heightPx * (script ? 0.7 : 0.6), 40));
  const size = field.fontSize ? field.fontSize * pxPerPt : auto;
  const multiline = field.type === "text" && field.multiline;
  return (
    <div className={cn("flex h-full w-full items-center overflow-hidden px-1", justify[align])} aria-hidden>
      <span
        className={cn("min-w-0 text-slate-900", multiline ? "whitespace-pre-wrap break-words" : "truncate whitespace-nowrap", sample.missing && "text-slate-500 italic")}
        style={{ fontSize: size, lineHeight: 1.15, fontFamily: script ? SCRIPT_FONT : undefined, fontStyle: script ? "italic" : undefined }}
      >
        {sample.text}
      </span>
    </div>
  );
}
