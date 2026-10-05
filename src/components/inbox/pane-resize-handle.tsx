"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { draggedPaneWidth, steppedPaneWidth } from "@/lib/inbox/pane-width";
import { cn } from "@/lib/utils";

interface PaneResizeHandleProps {
  /** Width of the panel this handle controls, in px. */
  width: number;
  /** The smallest the panel may be. */
  min: number;
  /** The largest the panel may be right now (depends on what else is open). */
  getMax: () => number;
  /** +1 when the panel sits before the handle (dragging right widens it), -1 when after. */
  dir: 1 | -1;
  onChange: (px: number) => void;
  onCommit: () => void;
  onReset: () => void;
  label: string;
}

/**
 * A thin draggable divider between two inbox panels. Drag it, use the arrow keys when it
 * has focus, or double-click to put the panel back to its normal width. Desktop only.
 */
export function PaneResizeHandle({ width, min, getMax, dir, onChange, onCommit, onReset, label }: PaneResizeHandleProps) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [active, setActive] = useState(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: width };
    setActive(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onChange(draggedPaneWidth(drag.current.startWidth, drag.current.startX, e.clientX, dir, min, getMax()));
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    setActive(false);
    onCommit();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    onChange(steppedPaneWidth(width, e.key, dir, min, getMax()));
    onCommit();
  };

  return (
    <div className="relative z-10 hidden w-0 shrink-0 lg:block">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={Math.round(width)}
        aria-valuemin={min}
        tabIndex={0}
        title={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={onKeyDown}
        onDoubleClick={onReset}
        className={cn(
          "absolute inset-y-0 -left-1 w-2 cursor-col-resize touch-none outline-none transition-colors",
          "hover:bg-primary/40 focus-visible:bg-primary/50",
          active && "bg-primary/60",
        )}
      />
    </div>
  );
}
