"use client";

// ============================================================
// Doc Sign, signing page: the sheet for a signature or initials. Three ways, as the person prefers:
// draw it, type it in a script font, or upload a picture. One adopted signature can be reused for the
// other places they have to sign or initial in this sitting.
// ============================================================

import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { PlacedField } from "@/lib/sign/pdf/types";
import type { AnswerInput } from "@/lib/sign/rules";
import { adoptedFromInput, answerFromAdopted, canTypeSignature, imageAnswer, initialsOf, typedAnswer, type Adopted } from "@/lib/sign/client/signer-flow";

import { AnswerPreview } from "./answer-preview";
import { DrawPad, type DrawPadHandle } from "./draw-pad";
import { fileToImageDataUrl } from "./image-utils";
import { FieldError, SheetActions } from "./sheet-parts";
import { signatureFontFamily } from "./signature-font";

type Mode = "draw" | "type" | "upload";

interface SignatureEditorProps {
  field: PlacedField;
  value: AnswerInput | undefined;
  signerName: string;
  /** A signature adopted earlier in this sitting. */
  adopted: Adopted | null;
  /** Apply the answer; `adopt` is the signature to keep for the other places (null: do not). */
  onApply: (input: AnswerInput, adopt: Adopted | null) => void;
  onClear: () => void;
}

export function SignatureEditor({ field, value, signerName, adopted, onApply, onClear }: SignatureEditorProps) {
  const t = useTranslations("Sign.signer");
  const initials = field.type === "initials";
  const startName = initials ? initialsOf(signerName) : signerName;
  const typable = canTypeSignature(startName);
  // A name in another writing cannot be typed as a signature, so start on drawing.
  const [mode, setMode] = useState<Mode>(value?.typed && typable ? "type" : "draw");
  const [typed, setTyped] = useState(() => (typeof value?.typed === "string" && value.typed ? value.typed : typable ? startName : ""));
  const [empty, setEmpty] = useState(true);
  const [picture, setPicture] = useState<string | null>(null);
  const [problem, setProblem] = useState<"drawFailed" | "pictureTooBig" | "pictureUnreadable" | null>(null);
  const [busy, setBusy] = useState(false);
  const [reuse, setReuse] = useState(true);
  const pad = useRef<DrawPadHandle>(null);
  const reuseId = useId();
  const typedId = useId();
  const errorId = useId();

  const typedOk = typed.trim().length > 0 && canTypeSignature(typed.trim());
  const canApply = mode === "draw" ? !empty : mode === "type" ? typedOk : picture !== null;
  const hasAnswer = !!value && (!!value.image || !!value.typed);

  function apply() {
    let input: AnswerInput | null = null;
    let adoptable: Adopted | null = null;
    if (mode === "draw") {
      const png = pad.current?.toPng() ?? null;
      if (!png) {
        setProblem("drawFailed");
        return;
      }
      input = imageAnswer(png);
      adoptable = adoptedFromInput(input, "draw");
    } else if (mode === "type") {
      input = typedAnswer(field, typed);
      adoptable = adoptedFromInput(input, "type");
    } else if (picture) {
      input = imageAnswer(picture);
      adoptable = adoptedFromInput(input, "upload");
    }
    if (input) onApply(input, reuse ? adoptable : null);
  }

  async function choose(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    const result = await fileToImageDataUrl(file, "signature");
    setBusy(false);
    if (result.ok) setPicture(result.dataUrl);
    else {
      setPicture(null);
      setProblem(result.reason === "too_big" ? "pictureTooBig" : "pictureUnreadable");
    }
  }

  return (
    <div className="space-y-4">
      {adopted ? (
        <div className="flex items-center gap-3 rounded-xl border bg-muted/40 p-3">
          <div className="h-14 w-32 shrink-0 rounded-md bg-white ring-1 ring-black/10">
            <AnswerPreview input={answerFromAdopted(field, adopted)} height={56} width={128} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("sheet.signature.savedTitle")}</p>
            <button
              type="button"
              className="mt-1 inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={() => onApply(answerFromAdopted(field, adopted), adopted)}
            >
              {t("sheet.signature.useSaved")}
            </button>
          </div>
        </div>
      ) : null}

      <Tabs value={mode} onValueChange={(v) => {
          setMode(v as Mode);
          // a pad that is shown again starts empty
          setEmpty(true);
          setProblem(null);
        }}>
        <TabsList className="grid w-full grid-cols-3 p-1 group-data-horizontal/tabs:h-12" aria-label={t("sheet.signature.ways")}>
          <TabsTrigger value="draw" className="h-10 text-sm">
            {t("sheet.signature.draw")}
          </TabsTrigger>
          <TabsTrigger value="type" className="h-10 text-sm">
            {t("sheet.signature.type")}
          </TabsTrigger>
          <TabsTrigger value="upload" className="h-10 text-sm">
            {t("sheet.signature.upload")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="draw" className="space-y-2">
          <DrawPad ref={pad} label={t("sheet.signature.drawLabel")} hint={t("sheet.signature.drawHint")} onEmptyChange={setEmpty} />
          <button
            type="button"
            className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() => {
              pad.current?.clear();
              setProblem(null);
            }}
          >
            {t("sheet.signature.clearDrawing")}
          </button>
        </TabsContent>

        <TabsContent value="type" className="space-y-3">
          <label htmlFor={typedId} className="block text-sm font-medium">
            {initials ? t("sheet.signature.typeInitialsLabel") : t("sheet.signature.typeLabel")}
          </label>
          <Input
            id={typedId}
            value={typed}
            maxLength={initials ? 10 : 100}
            autoComplete="off"
            className="h-11 text-base"
            aria-invalid={typed.trim().length > 0 && !typedOk}
            aria-describedby={typed.trim().length > 0 && !typedOk ? errorId : undefined}
            onChange={(e) => setTyped(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("sheet.signature.typePreview")}</p>
          <div className="flex h-24 items-center justify-center overflow-hidden rounded-xl border bg-white px-3 text-slate-900" aria-hidden>
            <span className="max-w-full truncate leading-none" style={{ fontFamily: signatureFontFamily, fontSize: initials ? 52 : 44 }}>
              {typed.trim()}
            </span>
          </div>
          {typed.trim().length > 0 && !typedOk ? <FieldError id={errorId}>{t("sheet.signature.typeLatinOnly")}</FieldError> : null}
        </TabsContent>

        <TabsContent value="upload" className="space-y-3">
          <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-input px-3 py-4 text-center text-sm focus-within:ring-3 focus-within:ring-ring/50">
            <span className="font-medium">{picture ? t("sheet.signature.chooseAnother") : t("sheet.signature.choose")}</span>
            <span className="text-xs text-muted-foreground">{t("sheet.signature.uploadHint")}</span>
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => void choose(e.target.files?.[0])} />
          </label>
          {busy ? <p className="text-sm text-muted-foreground">{t("sheet.signature.preparing")}</p> : null}
          {picture ? (
            <div className="h-24 rounded-xl border bg-white">
              <AnswerPreview input={imageAnswer(picture)} height={96} width={300} />
            </div>
          ) : null}
        </TabsContent>
      </Tabs>

      {problem ? <FieldError id={errorId}>{t(`sheet.signature.${problem}`)}</FieldError> : null}

      <div className="flex min-h-11 items-center gap-3">
        <input id={reuseId} type="checkbox" checked={reuse} onChange={(e) => setReuse(e.target.checked)} className="size-5 shrink-0 accent-[var(--primary)]" />
        <label htmlFor={reuseId} className="text-sm">
          {t("sheet.signature.reuse")}
        </label>
      </div>

      <SheetActions
        onApply={apply}
        applyLabel={t("sheet.apply")}
        applyDisabled={!canApply}
        applyBusy={busy}
        onClear={hasAnswer ? onClear : undefined}
        clearLabel={t("sheet.remove")}
      />
    </div>
  );
}
