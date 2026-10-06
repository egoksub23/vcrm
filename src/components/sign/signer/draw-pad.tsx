"use client";

// ============================================================
// Doc Sign, signing page: the pad a signature is drawn on (signature_pad). Large on a phone, white
// whatever the theme (the ink is dark and the picture has no background, so it reads on the white
// page), and it keeps the drawing when the screen turns. The parent reads the result through `ref`.
// ============================================================

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import SignaturePad from "signature_pad";

import { canvasToSignaturePng } from "./image-utils";

export interface DrawPadHandle {
  isEmpty: () => boolean;
  /** The drawing as a small PNG, or null when nothing is drawn. */
  toPng: () => string | null;
  clear: () => void;
}

interface DrawPadProps {
  ref?: Ref<DrawPadHandle>;
  label: string;
  hint: string;
  /** Called when the drawing becomes empty or not. */
  onEmptyChange: (empty: boolean) => void;
}

const INK = "#0f172a";

export function DrawPad({ ref, label, hint, onEmptyChange }: DrawPadProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pad = useRef<SignaturePad | null>(null);
  const notify = useRef(onEmptyChange);

  useEffect(() => {
    notify.current = onEmptyChange;
  }, [onEmptyChange]);

  useEffect(() => {
    const el = canvas.current;
    const box = wrap.current;
    if (!el || !box) return;
    const instance = new SignaturePad(el, { penColor: INK, backgroundColor: "rgba(0,0,0,0)", minWidth: 0.9, maxWidth: 2.8, throttle: 8 });
    pad.current = instance;

    const size = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const width = Math.floor(box.clientWidth);
      const height = Math.floor(box.clientHeight);
      if (width === 0 || height === 0) return;
      if (el.width === Math.floor(width * ratio) && el.height === Math.floor(height * ratio)) return;
      // resizing a canvas wipes it: keep the strokes and draw them again
      const strokes = instance.toData();
      el.width = Math.floor(width * ratio);
      el.height = Math.floor(height * ratio);
      el.getContext("2d")?.scale(ratio, ratio);
      instance.clear();
      if (strokes.length > 0) instance.fromData(strokes);
    };
    size();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(size);
    observer?.observe(box);

    const onEnd = () => notify.current(instance.isEmpty());
    instance.addEventListener("endStroke", onEnd);
    return () => {
      observer?.disconnect();
      instance.removeEventListener("endStroke", onEnd);
      instance.off();
      pad.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      isEmpty: () => pad.current?.isEmpty() ?? true,
      toPng: () => (canvas.current && pad.current && !pad.current.isEmpty() ? canvasToSignaturePng(canvas.current) : null),
      clear: () => {
        pad.current?.clear();
        notify.current(true);
      },
    }),
    [],
  );

  return (
    <div ref={wrap} className="relative h-56 w-full overflow-hidden rounded-xl border-2 border-dashed border-input bg-white sm:h-64">
      <canvas ref={canvas} role="img" aria-label={label} className="absolute inset-0 h-full w-full cursor-crosshair touch-none" />
      <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-slate-500">{hint}</p>
      <div className="pointer-events-none absolute inset-x-6 bottom-9 border-b border-slate-300" aria-hidden />
    </div>
  );
}
