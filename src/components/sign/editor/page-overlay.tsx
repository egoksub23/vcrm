"use client";

// The layer over one page: draws its fields and takes clicks and drags on the empty page to place a new field.

import { memo, useCallback, useEffect, useMemo, useRef, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";

import type { SampleContext } from "@/lib/sign/client/editor-preview";
import { pick } from "@/lib/sign/forms/text";
import type { FormDefinition } from "@/lib/sign/forms/types";
import { clampRect, rectForDraw, rectFromPoints, type Rect } from "@/lib/sign/client/layout";
import { FIELD_TYPES, type FieldType, type PlacedField } from "@/lib/sign/pdf/types";
import { SENDER_ROLE } from "@/lib/sign/rules";
import type { SignLocale, SignRole } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

import { FieldBox, type FieldBoxCallbacks } from "./field-box";

export const FIELD_DRAG_TYPE = "application/x-sign-field-type";

export interface PageOverlayCallbacks {
  select: (key: string | null) => void;
  commitRect: (key: string, rect: Rect) => void;
  place: (type: FieldType, page: number, rect: Rect, keepTool: boolean) => void;
}

export interface PageOverlayProps {
  page: number;
  fields: readonly PlacedField[];
  roles: readonly SignRole[];
  selectedKey: string | null;
  tool: FieldType | null;
  readOnly: boolean;
  preview: boolean;
  sampleCtx: SampleContext;
  issueKeys: ReadonlySet<string>;
  pageWidth: number;
  pageHeight: number;
  pxPerPt: number;
  typeLabels: Record<FieldType, string>;
  senderLabel: string;
  /** Forms: the template's form, so a placement that prints a data field can show that field's label. */
  form?: FormDefinition | null;
  /** The language the data labels are shown in. */
  labelLocale?: SignLocale;
  callbacks: PageOverlayCallbacks;
}

interface Drawing {
  pointerId: number;
  start: { x: number; y: number };
  type: FieldType;
  moved: boolean;
}

function PageOverlayImpl({ page, fields, roles, selectedKey, tool, readOnly, preview, sampleCtx, issueKeys, pageWidth, pageHeight, pxPerPt, typeLabels, senderLabel, form, labelLocale = "en", callbacks }: PageOverlayProps) {
  const siblings = useRef<readonly PlacedField[]>(fields);
  useEffect(() => {
    siblings.current = fields;
  });
  const root = useRef<HTMLDivElement>(null);
  const guideV = useRef<HTMLDivElement>(null);
  const guideH = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const drawing = useRef<Drawing | null>(null);
  const aspect = pageHeight / Math.max(1, pageWidth);

  const guides = useCallback((x: number | null, y: number | null) => {
    const v = guideV.current;
    const h = guideH.current;
    if (v) {
      v.style.display = x === null ? "none" : "block";
      if (x !== null) v.style.left = `${x * 100}%`;
    }
    if (h) {
      h.style.display = y === null ? "none" : "block";
      if (y !== null) h.style.top = `${y * 100}%`;
    }
  }, []);

  // stable wrappers that always call the latest callbacks, so a field box is not redrawn for them
  const latest = useRef(callbacks);
  useEffect(() => {
    latest.current = callbacks;
  });
  const stableBox = useMemo<FieldBoxCallbacks>(
    () => ({
      select: (k) => latest.current.select(k),
      commitRect: (k, r) => latest.current.commitRect(k, r),
      guides,
    }),
    [guides],
  );

  const point = (e: { clientX: number; clientY: number }) => {
    const r = root.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return null;
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  const paintGhost = (r: Rect | null) => {
    const g = ghost.current;
    if (!g) return;
    if (!r) {
      g.style.display = "none";
      return;
    }
    g.style.display = "block";
    g.style.left = `${r.x * 100}%`;
    g.style.top = `${r.y * 100}%`;
    g.style.width = `${r.w * 100}%`;
    g.style.height = `${r.h * 100}%`;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (!tool || readOnly) {
      if (e.target === e.currentTarget) callbacks.select(null);
      return;
    }
    const p = point(e);
    if (!p) return;
    e.preventDefault();
    root.current?.setPointerCapture(e.pointerId);
    drawing.current = { pointerId: e.pointerId, start: p, type: tool, moved: false };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drawing.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const p = point(e);
    if (!p) return;
    if (!d.moved && Math.hypot((p.x - d.start.x) * pageWidth, (p.y - d.start.y) * pageHeight) < 6) return;
    d.moved = true;
    paintGhost(clampRect(rectFromPoints(d.start, p)));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drawing.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drawing.current = null;
    paintGhost(null);
    if (root.current?.hasPointerCapture(e.pointerId)) root.current.releasePointerCapture(e.pointerId);
    const p = point(e) ?? d.start;
    // a drag shorter than 8 pixels is a click: drop the default size there
    const rect = rectForDraw(d.type, aspect, d.start, p, 8 / Math.max(1, pageWidth));
    callbacks.place(d.type, page, rect, e.shiftKey);
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drawing.current?.pointerId !== e.pointerId) return;
    drawing.current = null;
    paintGhost(null);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (readOnly || !e.dataTransfer.types.includes(FIELD_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const type = e.dataTransfer.getData(FIELD_DRAG_TYPE) as FieldType;
    if (!(FIELD_TYPES as readonly string[]).includes(type)) return;
    e.preventDefault();
    const p = point(e);
    if (!p) return;
    callbacks.place(type, page, rectForDraw(type, aspect, p, p, 1), e.shiftKey);
  };

  const roleByKey = new Map(roles.map((r) => [r.key, r]));
  return (
    <div
      ref={root}
      className={cn("absolute inset-0", tool && !readOnly ? "cursor-crosshair touch-none" : "")}
      data-overlay={page}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {fields.map((f) => (
        <FieldBox
          key={f.key}
          field={f}
          role={f.role === SENDER_ROLE ? null : (roleByKey.get(f.role) ?? null)}
          senderLabel={senderLabel}
          typeLabel={typeLabels[f.type]}
          selected={f.key === selectedKey}
          readOnly={readOnly}
          toolArmed={!!tool && !readOnly}
          preview={preview}
          sampleCtx={sampleCtx}
          hasIssue={issueKeys.has(f.key)}
          dataLabel={f.data ? dataLabelOf(form, f.data, labelLocale) : undefined}
          pageWidth={pageWidth}
          pageHeight={pageHeight}
          pxPerPt={pxPerPt}
          siblings={siblings}
          callbacks={stableBox}
        />
      ))}
      <div ref={guideV} className="pointer-events-none absolute inset-y-0 z-30 hidden w-px bg-fuchsia-500" aria-hidden />
      <div ref={guideH} className="pointer-events-none absolute inset-x-0 z-30 hidden h-px bg-fuchsia-500" aria-hidden />
      <div ref={ghost} className="pointer-events-none absolute z-30 hidden border border-dashed border-primary bg-primary/10" aria-hidden />
    </div>
  );
}

/** The label a bound placement shows: its data field's, or "{{key}}" when the field is gone. */
function dataLabelOf(form: FormDefinition | null | undefined, key: string, locale: SignLocale): string {
  const field = form?.fields.find((x) => x.key === key);
  return field ? pick(field.label, locale) || field.key : `{{${key}}}`;
}

export const PageOverlay = memo(PageOverlayImpl);
