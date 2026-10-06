"use client";

// ============================================================
// Doc Sign, signing page: what is drawn over one page of the document.
//
//   this person's fields   boxes to tap: amber while there is something to do, green once done, red when
//                          the value was not acceptable. Each says in words what to do ("Tap to sign");
//                          colour is never the only signal.
//   the system's fields    the person's name and the signing date, written for them: shown, not tapped.
//   others' answers        what earlier signers entered, drawn read-only.
//
// Everything is positioned in fractions of the page, as percentages, like the PDF engine reads them. A box
// smaller than a finger is grown to 44 px around its middle where the page has room (touchRects).
// ============================================================

import { AlertCircle, Check, Pencil } from "lucide-react";
import { useTranslations } from "next-intl";

import type { PlacedField } from "@/lib/sign/pdf/types";
import type { AnswerInput } from "@/lib/sign/rules";
import { hasValue, touchRects, type FieldStatus } from "@/lib/sign/client/signer-flow";
import { cn } from "@/lib/utils";

import { AnswerPreview } from "./answer-preview";
import { useFieldLabel } from "./field-sheet";
import { useProblemText } from "./sheet-parts";

function place(f: Pick<PlacedField, "x" | "y" | "w" | "h">) {
  return { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` } as const;
}

const BOX: Record<FieldStatus, string> = {
  todo: "border-2 border-amber-500 bg-amber-300/30 text-amber-950",
  optional: "border-2 border-dashed border-amber-600/70 bg-amber-200/20 text-amber-950",
  done: "border-2 border-emerald-600 bg-emerald-300/15 text-emerald-950",
  invalid: "border-2 border-red-600 bg-red-300/30 text-red-950",
};

export interface MyFieldView {
  field: PlacedField;
  status: FieldStatus;
  input: AnswerInput | undefined;
  /** The reason the value is not acceptable, worded, when there is one. */
  problemCode: string | null;
}

interface FieldLayerProps {
  /** Page size on screen, in pixels. */
  size: { width: number; height: number };
  mine: MyFieldView[];
  system: { field: PlacedField; text: string }[];
  others: { field: PlacedField; input: AnswerInput }[];
  highlightKey: string | null;
  onActivate: (field: PlacedField) => void;
}

export function FieldLayer({ size, mine, system, others, highlightKey, onActivate }: FieldLayerProps) {
  const t = useTranslations("Sign.signer");
  const labelOf = useFieldLabel();
  const problemText = useProblemText();
  // each box to tap is at least a finger wide where the page has room, and never runs into the next one
  const boxes = touchRects(
    mine.map((v) => v.field),
    size,
  );

  return (
    <div className="absolute inset-0">
      {others.map(({ field, input }) => (
        <div key={field.key} className="pointer-events-none absolute border border-slate-300/70" style={place(field)} aria-hidden>
          <AnswerPreview input={input} width={field.w * size.width} height={field.h * size.height} multiline={field.multiline} align={field.align} />
        </div>
      ))}

      {system.map(({ field, text }) => (
        <div key={field.key} className="pointer-events-none absolute border border-dashed border-slate-400 bg-slate-200/40" style={place(field)} title={t("status.system")} aria-hidden>
          <AnswerPreview input={{ text }} width={field.w * size.width} height={field.h * size.height} align={field.align} />
        </div>
      ))}

      {mine.map(({ field, status, input, problemCode }) => {
        const box = boxes[field.key];
        const heightPx = box.h * size.height;
        const widthPx = box.w * size.width;
        const checkbox = field.type === "checkbox";
        const showValue = status === "done" || (status === "invalid" && hasValue(input));
        const statusWord = t(`status.${status}`);
        const problem = status === "invalid" ? problemText(problemCode) : null;
        return (
          <div key={field.key} className="absolute" style={place(box)}>
            <button
              type="button"
              data-field-key={field.key}
              role={checkbox ? "checkbox" : undefined}
              aria-checked={checkbox ? status === "done" : undefined}
              aria-haspopup={checkbox ? undefined : "dialog"}
              aria-invalid={status === "invalid" || undefined}
              aria-required={field.required || undefined}
              aria-label={`${labelOf(field)}: ${statusWord}${problem ? `. ${problem}` : ""}`}
              onClick={() => onActivate(field)}
              className={cn(
                "relative flex h-full w-full touch-manipulation items-center justify-center overflow-hidden rounded-[3px] outline-none transition-colors focus-visible:ring-4 focus-visible:ring-primary",
                BOX[status],
                highlightKey === field.key && "ring-4 ring-primary motion-safe:animate-pulse",
              )}
            >
              {showValue ? (
                <AnswerPreview input={input} width={widthPx} height={heightPx} multiline={field.multiline} align={field.align} className="text-slate-900" />
              ) : (
                <span className="flex max-w-full items-center justify-center gap-1 px-1 text-[11px] font-semibold leading-tight sm:text-xs">
                  {checkbox ? null : <Pencil className="size-3 shrink-0" aria-hidden />}
                  <span className="truncate">{t(`tap.${field.type}`)}</span>
                </span>
              )}
              {status === "done" ? <Check className="absolute right-0.5 top-0.5 size-3.5 rounded-full bg-emerald-600 p-0.5 text-white" aria-hidden /> : null}
              {status === "invalid" ? <AlertCircle className="absolute right-0.5 top-0.5 size-4 rounded-full bg-red-600 p-px text-white" aria-hidden /> : null}
            </button>
            {problem ? (
              <span className="pointer-events-none absolute left-0 top-full z-10 mt-0.5 w-max max-w-[14rem] rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-medium leading-tight text-white shadow">{problem}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
