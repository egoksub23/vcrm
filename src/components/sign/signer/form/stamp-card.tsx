"use client";

// ============================================================
// Secure Sign, signing page, forms in parts: the two ways to give a company stamp. A picture field that has a `stamp` option (types.ts
// `StampSource`) shows a choice (two radio buttons, so the arrow keys work): "Upload your stamp", which is the ordinary control for the
// field, and "Create a stamp from your company details". Create opens a card:
//
//   needs     the company name or the new registration number is not in yet: it says which, with a button to each
//   preview   the stamp drawn live from the form's own answers (it follows every key typed), "Use this stamp", and a way back
//   saved     a stamp made here is the answer: its thumbnail, "Created from your company details", Replace and Remove
//
// The picture is drawn as an SVG string (src/lib/sign/client/stamp.ts) and turned into a PNG with a canvas (../stamp-image.ts); "Use this
// stamp" then saves that PNG exactly as a picture the person chose themselves would be saved: the same answer, the same size and
// type checks in the browser and on the server, nothing special for the server to know.
// ============================================================

import { useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Loader2, Stamp } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { canMakeStamp, initialStampWay, stampCardState, stampDataUrl, stampInputs, stampIsStale, stampSignature, stampSvg, type StampWay } from "@/lib/sign/client/stamp";
import type { AnswerMap, DataField, FormDefinition } from "@/lib/sign/forms/types";
import { cn } from "@/lib/utils";

import { stampSvgToPng, type StampPngResult } from "../stamp-image";
import { useFormText } from "./form-ui";

export interface StampChoiceProps {
  field: DataField;
  /** The id of the field's control: the radio group builds its own from it. */
  id: string;
  definition: FormDefinition;
  /** The answers as they stand while the person types: the stamp follows them. */
  answers: AnswerMap;
  /** The picture the field holds now (a picture field), or null. */
  picture: string | null;
  /** The name of a stamp already uploaded from here (a file field), or null. */
  savedName?: string | null;
  /** The ordinary control for the field: shown for "Upload your stamp". */
  children: ReactNode;
  /** Save the made stamp as the field's answer. Answers whether it was saved. */
  onUse: (made: Extract<StampPngResult, { ok: true }>) => Promise<boolean>;
  /** Remove the stamp that was made here. */
  onRemove: () => void;
  /** Take the person to the field of the form that holds a detail the stamp needs. */
  onGoToField?: (key: string) => void;
  /** Where the card opens, and what an earlier stamp was made from: the first paint of a screen the person got to by clicking (the render tests). */
  initialWay?: StampWay;
  initialMadeFrom?: string | null;
}

export function StampChoice({ field, id, definition, answers, picture, savedName = null, children, onUse, onRemove, onGoToField, initialWay, initialMadeFrom = null }: StampChoiceProps) {
  const t = useTranslations("Sign.signerForm");
  const text = useFormText();
  const [way, setWay] = useState<StampWay>(initialWay ?? initialStampWay());
  // what the stamp saved from this page was made from; only known until the page is left
  const [madeFrom, setMadeFrom] = useState<string | null>(initialMadeFrom);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<"unsupported" | "too_big" | "not_saved" | null>(null);

  const source = field.stamp;
  const inputs = useMemo(() => (source ? stampInputs(definition, source, answers) : null), [definition, source, answers]);
  const ready = inputs !== null && canMakeStamp(inputs);
  const svg = useMemo(() => (ready && inputs ? stampSvg(inputs) : ""), [ready, inputs]);
  const previewUrl = svg ? stampDataUrl(svg) : null;

  if (!source || !inputs) return <>{children}</>;

  const created = savedName !== null || (picture !== null && madeFrom !== null);
  const state = stampCardState({ inputs, created, replacing });
  const stale = stampIsStale(madeFrom, inputs);
  const label = (key: string) => text(definition.fields.find((f) => f.key === key)?.label) || key;
  const alt = inputs.oldNumber ? t("stamp.alt.withOld", { name: inputs.name, number: inputs.newNumber, old: inputs.oldNumber }) : t("stamp.alt.plain", { name: inputs.name, number: inputs.newNumber });

  async function use() {
    if (!svg) return;
    setBusy(true);
    setProblem(null);
    const made = await stampSvgToPng(svg);
    if (!made.ok) {
      setBusy(false);
      setProblem(made.reason);
      return;
    }
    const saved = await onUse(made);
    setBusy(false);
    if (!saved) {
      setProblem("not_saved");
      return;
    }
    setMadeFrom(stampSignature(inputs as NonNullable<typeof inputs>));
    setReplacing(false);
  }

  function remove() {
    onRemove();
    setMadeFrom(null);
    setReplacing(false);
    setProblem(null);
    setWay("upload");
  }

  // leaving the card for the upload: nothing the field holds is touched
  const another = (
    <Button
      type="button"
      variant="outline"
      className="h-11 w-full px-4 text-base whitespace-normal sm:w-auto"
      onClick={() => {
        setReplacing(false);
        setWay("upload");
      }}
    >
      {t("stamp.another")}
    </Button>
  );

  const choice = (value: StampWay, words: string) => (
    <label
      key={value}
      className={cn(
        "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-base leading-snug",
        way === value ? "border-primary bg-primary/5" : "bg-background",
        "has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
      )}
    >
      <input type="radio" name={`${id}-way`} value={value} checked={way === value} onChange={() => setWay(value)} className="mt-1 size-4 shrink-0 accent-[color:light-dark(#2b2f8f,#a5b4fc)]" />
      <span>{words}</span>
    </label>
  );

  return (
    <div className="space-y-3" data-stamp-choice={way}>
      <div role="radiogroup" aria-label={t("stamp.way.label")} className="grid gap-2 sm:grid-cols-2">
        {choice("upload", t("stamp.way.upload"))}
        {choice("create", t("stamp.way.create"))}
      </div>

      {way === "upload" ? (
        children
      ) : (
        <div className="space-y-3 rounded-xl border bg-muted/30 p-3" data-stamp-card={state}>
          {state === "needs" ? (
            <>
              <p className="flex items-start gap-2 text-base font-medium leading-snug">
                <Stamp className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                {t("stamp.needs.title")}
              </p>
              <p className="text-sm text-muted-foreground">{t("stamp.needs.body")}</p>
              <ul className="space-y-2">
                {inputs.missing.map((key) => (
                  <li key={key}>
                    {onGoToField ? (
                      <Button type="button" variant="outline" className="h-11 w-full justify-start px-3 text-left text-base whitespace-normal" onClick={() => onGoToField(key)}>
                        {t("stamp.needs.go", { field: label(key) })}
                      </Button>
                    ) : (
                      <span className="block rounded-lg border bg-background px-3 py-2.5 text-base">{label(key)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              {state === "preview" && previewUrl ? (
                // the stamp as it will be printed, on white
                <div className="mx-auto flex aspect-square w-full max-w-64 items-center justify-center rounded-xl border bg-white p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previewUrl} alt={alt} className="size-full object-contain" draggable={false} />
                </div>
              ) : (
                <div className="mx-auto flex aspect-square w-full max-w-40 items-center justify-center rounded-xl border bg-white p-2">
                  {picture ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={picture} alt={t("stamp.alt.saved")} className="size-full object-contain" draggable={false} />
                  ) : (
                    <p className="break-all px-1 text-center text-sm text-neutral-700">{savedName}</p>
                  )}
                </div>
              )}

              {state === "saved" ? (
                <p role="status" className="flex items-start gap-2 text-sm font-medium">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[light-dark(#047857,#6ee7b7)]" aria-hidden />
                  {t("stamp.created")}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{t("stamp.note")}</p>
              )}

              {inputs.warnNumber && state === "preview" ? (
                <p role="note" className="rounded-lg border border-[color:light-dark(#fcd34d,#92400e)] bg-[color:light-dark(#fffbeb,#451a03)] px-3 py-2 text-sm text-[light-dark(#451a03,#fef3c7)]">
                  {t("stamp.numberWarning")}
                </p>
              ) : null}
              {stale && state === "saved" ? (
                <p role="note" className="rounded-lg border border-[color:light-dark(#fcd34d,#92400e)] bg-[color:light-dark(#fffbeb,#451a03)] px-3 py-2 text-sm text-[light-dark(#451a03,#fef3c7)]">
                  {t("stamp.stale")}
                </p>
              ) : null}

              {problem ? (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {problem === "not_saved" ? t("stamp.problem.notSaved") : problem === "too_big" ? t("stamp.problem.tooBig") : t("stamp.problem.unsupported")}
                </p>
              ) : null}

              <div className="flex flex-col gap-2 sm:flex-row">
                {state === "preview" ? (
                  <>
                    <Button type="button" className="h-11 flex-1 px-4 text-base sm:flex-none" disabled={busy} onClick={() => void use()}>
                      {busy ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : null}
                      {busy ? t("stamp.making") : t("stamp.use")}
                    </Button>
                    {another}
                  </>
                ) : (
                  <>
                    <Button type="button" variant="outline" className="h-11 flex-1 px-4 text-base sm:flex-none" onClick={() => setReplacing(true)}>
                      {t("stamp.replace")}
                    </Button>
                    <Button type="button" variant="outline" className="h-11 flex-1 px-4 text-base whitespace-normal sm:flex-none" onClick={remove}>
                      {t("stamp.remove")}
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
          {state === "needs" ? another : null}
        </div>
      )}
    </div>
  );
}
