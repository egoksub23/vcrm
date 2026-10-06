"use client";

// ============================================================
// Doc Sign, signing page: what an answer looks like on the page, small: a drawn or uploaded picture, a
// typed signature in the script font, text, or a tick. Used in the boxes over the page and in the sheets.
// ============================================================

import { Check } from "lucide-react";

import type { AnswerInput } from "@/lib/sign/rules";
import { cn } from "@/lib/utils";

import { signatureFontFamily } from "./signature-font";

interface AnswerPreviewProps {
  input: AnswerInput | undefined;
  /** The room it has, in pixels, to size typed words to it. */
  height: number;
  width: number;
  multiline?: boolean;
  align?: "left" | "center" | "right";
  className?: string;
}

// The page is white whatever the theme, so what is written on it is always dark.
const PAPER_INK = "text-slate-900";

export function AnswerPreview({ input, height, width, multiline, align = "left", className }: AnswerPreviewProps) {
  if (!input) return null;
  if (typeof input.image === "string" && input.image) {
    // a data URL the person just made, or one the server stored for them
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={input.image} alt="" className={cn("h-full w-full object-contain", className)} draggable={false} />;
  }
  if (typeof input.typed === "string" && input.typed) {
    const size = Math.max(10, Math.min(height * 0.72, (width / Math.max(input.typed.length, 4)) * 1.9, 44));
    return (
      <span className={cn("flex h-full w-full items-center justify-center overflow-hidden whitespace-nowrap leading-none", PAPER_INK, className)} style={{ fontFamily: signatureFontFamily, fontSize: size }}>
        {input.typed}
      </span>
    );
  }
  if (input.checked === true) {
    return (
      <span className={cn("flex h-full w-full items-center justify-center", PAPER_INK, className)}>
        <Check className="h-[80%] w-[80%]" strokeWidth={3} aria-hidden />
      </span>
    );
  }
  if (typeof input.text === "string" && input.text) {
    const size = Math.max(9, Math.min(multiline ? 14 : height * 0.62, 18));
    return (
      <span
        className={cn("h-full w-full overflow-hidden px-1", multiline ? "block whitespace-pre-wrap break-words py-0.5" : "flex items-center whitespace-nowrap", PAPER_INK, className)}
        style={{ fontSize: size, lineHeight: 1.2, textAlign: align, justifyContent: align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start" }}
      >
        {input.text}
      </span>
    );
  }
  return null;
}
