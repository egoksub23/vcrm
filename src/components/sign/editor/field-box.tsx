"use client";

// One field drawn over a page. Moving and resizing are done on the element itself while the pointer is down
// (its style is written directly, nothing re-renders), and the new rectangle is handed to the editor once when
// the pointer is released: a drag costs one render however many fields there are.

import { memo, useMemo, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { roleColorStyle } from "@/lib/sign/client/colors";
import { sampleValue, type SampleContext } from "@/lib/sign/client/editor-preview";
import { HANDLES, rectOf, resizeRect, snapMove, snapResize, snapTargets, moveRect, type Handle, type Rect, type SnapTargets } from "@/lib/sign/client/layout";
import type { PlacedField } from "@/lib/sign/pdf/types";
import { SENDER_ROLE } from "@/lib/sign/rules";
import type { SignRole } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

import { FieldVisual } from "./field-visual";

export interface FieldBoxCallbacks {
  select: (key: string) => void;
  commitRect: (key: string, rect: Rect) => void;
  /** Show alignment guides at these fractions of the page (null: hide). */
  guides: (x: number | null, y: number | null) => void;
}

export interface FieldBoxProps {
  field: PlacedField;
  role: SignRole | null;
  senderLabel: string;
  typeLabel: string;
  selected: boolean;
  readOnly: boolean;
  toolArmed: boolean;
  preview: boolean;
  sampleCtx: SampleContext;
  hasIssue: boolean;
  pageWidth: number;
  pageHeight: number;
  pxPerPt: number;
  /** The fields of this page, read when a drag starts (to snap to them). */
  siblings: RefObject<readonly PlacedField[]>;
  callbacks: FieldBoxCallbacks;
}

const HANDLE_POS: Record<Handle, { left: string; top: string; cursor: string }> = {
  nw: { left: "0%", top: "0%", cursor: "nwse-resize" },
  n: { left: "50%", top: "0%", cursor: "ns-resize" },
  ne: { left: "100%", top: "0%", cursor: "nesw-resize" },
  e: { left: "100%", top: "50%", cursor: "ew-resize" },
  se: { left: "100%", top: "100%", cursor: "nwse-resize" },
  s: { left: "50%", top: "100%", cursor: "ns-resize" },
  sw: { left: "0%", top: "100%", cursor: "nesw-resize" },
  w: { left: "0%", top: "50%", cursor: "ew-resize" },
};

interface Drag {
  pointerId: number;
  handle: Handle | null;
  startX: number;
  startY: number;
  start: Rect;
  box: { width: number; height: number };
  targets: SnapTargets;
  engaged: boolean;
  last: Rect;
  touch: boolean;
}

function paint(el: HTMLElement, r: Rect) {
  el.style.left = `${r.x * 100}%`;
  el.style.top = `${r.y * 100}%`;
  el.style.width = `${r.w * 100}%`;
  el.style.height = `${r.h * 100}%`;
}

function FieldBoxImpl({ field, role, senderLabel, typeLabel, selected, readOnly, toolArmed, preview, sampleCtx, hasIssue, pageWidth, pageHeight, pxPerPt, siblings, callbacks }: FieldBoxProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const roleLabel = role ? role.label : senderLabel;
  const style = useMemo(() => roleColorStyle(role ? role.color : null, "light"), [role]);
  const sample = useMemo(() => (preview || field.merge ? sampleValue(field, sampleCtx) : null), [preview, field, sampleCtx]);
  const widthPx = field.w * pageWidth;
  const heightPx = field.h * pageHeight;
  const caption = field.label?.trim() || (field.merge ? sample?.text || `{{${field.merge}}}` : field.type === "static_text" ? field.text || typeLabel : typeLabel);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || toolArmed) return;
    e.stopPropagation();
    const el = ref.current;
    if (!el) return;
    callbacks.select(field.key);
    el.focus({ preventScroll: true });
    if (readOnly) return;
    const page = el.parentElement?.getBoundingClientRect();
    if (!page || page.width === 0 || page.height === 0) return;
    const handle = (e.target as HTMLElement).closest<HTMLElement>("[data-handle]")?.dataset.handle as Handle | undefined;
    const others = (siblings.current ?? []).filter((f) => f.key !== field.key);
    // fields must be selected before they can be dragged on a touch screen (the first touch scrolls)
    if (e.pointerType === "touch" && !selected && !handle) return;
    drag.current = {
      pointerId: e.pointerId,
      handle: handle ?? null,
      startX: e.clientX,
      startY: e.clientY,
      start: rectOf(field),
      box: { width: page.width, height: page.height },
      targets: snapTargets(others),
      engaged: false,
      last: rectOf(field),
      touch: e.pointerType === "touch",
    };
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el || e.pointerId !== d.pointerId) return;
    const px = e.clientX - d.startX;
    const py = e.clientY - d.startY;
    if (!d.engaged) {
      if (Math.hypot(px, py) < (d.touch ? 6 : 3)) return;
      d.engaged = true;
    }
    const dx = px / d.box.width;
    const dy = py / d.box.height;
    const snapping = !e.altKey;
    const threshold = 6 / d.box.width;
    let rect: Rect;
    let gx: number | null = null;
    let gy: number | null = null;
    if (d.handle) {
      rect = resizeRect(d.start, d.handle, dx, dy);
      if (snapping) {
        const s = snapResize(rect, d.handle, d.targets, threshold);
        rect = s.rect;
        gx = s.guideX;
        gy = s.guideY;
      }
    } else {
      rect = moveRect(d.start, dx, dy);
      if (snapping) {
        const s = snapMove(rect, d.targets, threshold);
        rect = s.rect;
        gx = s.guideX;
        gy = s.guideY;
      }
    }
    d.last = rect;
    paint(el, rect);
    callbacks.guides(gx, gy);
  };

  const finish = (e: ReactPointerEvent<HTMLDivElement>, cancel: boolean) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el || e.pointerId !== d.pointerId) return;
    drag.current = null;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    callbacks.guides(null, null);
    if (!d.engaged) return;
    if (cancel) paint(el, d.start);
    else callbacks.commitRect(field.key, d.last);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = ref.current;
    if (e.key === "Escape" && d && el) {
      e.stopPropagation();
      drag.current = null;
      if (el.hasPointerCapture(d.pointerId)) el.releasePointerCapture(d.pointerId);
      paint(el, d.start);
      callbacks.guides(null, null);
    }
  };

  const filled = preview;
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={selected ? 0 : -1}
      aria-pressed={selected}
      aria-label={`${typeLabel}, ${roleLabel}${field.label ? `, ${field.label}` : ""}`}
      data-field={field.key}
      title={`${typeLabel} · ${roleLabel}`}
      className={cn(
        "absolute box-border rounded-[3px] border outline-none",
        filled ? "border-dashed bg-transparent" : "bg-clip-padding",
        "border-[color:var(--rc-solid)]",
        !filled && "bg-[var(--rc-fill)] text-[color:var(--rc-text)]",
        filled && "text-slate-900",
        hasIssue && "border-destructive! border-dashed",
        selected ? "z-20 shadow-[0_0_0_2px_var(--rc-solid)]" : "z-10 hover:shadow-[0_0_0_1px_var(--rc-solid)]",
        "focus-visible:shadow-[0_0_0_2px_var(--rc-solid),0_0_0_4px_rgba(255,255,255,0.9)]",
        toolArmed ? "pointer-events-none" : readOnly ? "cursor-pointer" : selected ? "cursor-move touch-none" : "cursor-pointer touch-pan-y",
        role === null && field.role !== SENDER_ROLE && "opacity-80",
      )}
      style={{ ...style, left: `${field.x * 100}%`, top: `${field.y * 100}%`, width: `${field.w * 100}%`, height: `${field.h * 100}%` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onKeyDown={onKeyDown}
    >
      <FieldVisual field={field} caption={caption} roleLabel={roleLabel} widthPx={widthPx} heightPx={heightPx} pxPerPt={pxPerPt} sample={preview ? sample : null} hasIssue={hasIssue} />
      {selected && !readOnly
        ? HANDLES.map((h) => (
            <span
              key={h}
              data-handle={h}
              className="absolute z-30 flex size-6 touch-none items-center justify-center pointer-fine:size-4"
              style={{ left: HANDLE_POS[h].left, top: HANDLE_POS[h].top, cursor: HANDLE_POS[h].cursor, transform: "translate(-50%, -50%)" }}
            >
              <span className="block size-2 rounded-[2px] border border-[color:var(--rc-solid)] bg-white pointer-fine:size-[7px]" />
            </span>
          ))
        : null}
    </div>
  );
}

export const FieldBox = memo(FieldBoxImpl);
