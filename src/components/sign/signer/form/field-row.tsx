"use client";

// ============================================================
// Doc Sign, signing page, forms in parts: one data field as the person sees it: its real label with a
// mark for required (a star, and the word for a screen reader) or the word "optional", the author's help,
// the control for its type, and under it the one thing wrong with it, if anything. A field the sender
// locked is shown as text, not as a control. An answer that came from the contact says so.
// ============================================================

import { useId, type ReactNode } from "react";
import { History, Lock } from "lucide-react";
import { useTranslations } from "next-intl";

import { STAMP_FILE_NAME } from "@/lib/sign/client/stamp";
import { displayValue } from "@/lib/sign/forms/text";
import type { AnswerMap, DataAnswerInput, DataField, FormDefinition, FormValueView } from "@/lib/sign/forms/types";
import { documentBadge, toAnswerMap, type FormRejection } from "@/lib/sign/client/signer-form";
import { cn } from "@/lib/utils";

import { ChoiceControl, MultichoiceControl, AcknowledgeControl, YesNoControl } from "./choice-control";
import type { ControlProps } from "./control-props";
import { FileControl, ImageControl } from "./file-control";
import { useFormLocale, useFormText, useProblemText } from "./form-ui";
import { ListControl } from "./list-control";
import { SensitiveControl } from "./sensitive-control";
import { StampChoice } from "./stamp-card";
import { TextControl } from "./text-control";

/** These are a set of controls under one heading, not one control under a label. */
const GROUPS = new Set<DataField["type"]>(["choice", "multichoice", "yesno", "list", "file", "image", "acknowledge"]);
/** A choice shown as a menu is one control and is labelled as one. */
const isGroup = (field: DataField): boolean => GROUPS.has(field.type) && !(field.type === "choice" && (field.options?.length ?? 0) > 5);

export interface FieldRowProps {
  field: DataField;
  /** What the control shows: the draft, or what is stored. */
  input: DataAnswerInput;
  /** What is stored, for a locked field and for the files. */
  stored: FormValueView | undefined;
  required: boolean;
  /** The answer came from the contact and has not been confirmed. */
  unconfirmed: boolean;
  /** The one problem to show, or null. */
  rejection: FormRejection | null;
  onInput: (input: DataAnswerInput) => void;
  onBlur: () => void;
  onUpload?: (key: string, file: File, onProgress?: (fraction: number) => void) => Promise<void>;
  onRemoveUpload?: (key: string, fileId: string) => Promise<void>;
  /** For a picture field that can make its picture from other answers (a company stamp): the form and the answers as they stand. */
  definition?: FormDefinition;
  answers?: AnswerMap;
  /** Take the person to another field of the form (a detail the stamp needs). */
  onGoToField?: (key: string) => void;
}

export function FieldRow({ field, input, stored, required, unconfirmed, rejection, onInput, onBlur, onUpload, onRemoveUpload, definition, answers, onGoToField }: FieldRowProps) {
  const t = useTranslations("Sign.signerForm");
  const text = useFormText();
  const locale = useFormLocale();
  const problemText = useProblemText();
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;

  const label = text(field.label);
  const help = text(field.help);
  const problem = problemText(rejection, field);
  const describedBy = [help ? helpId : null, problem ? errorId : null].filter(Boolean).join(" ") || undefined;
  const group = isGroup(field);
  // a document to upload says in words whether it is needed, for the answers so far (a star alone does not say "for whom")
  const badge = field.type === "file" && !field.locked ? documentBadge(field, required) : null;

  const heading = (
    <>
      {label}
      {badge ? (
        <span
          data-document-badge={badge}
          className={cn(
            "ml-2 inline-flex items-center rounded-full border px-2 py-0.5 align-middle text-xs font-medium leading-snug",
            badge === "optional" ? "bg-muted text-muted-foreground" : "border-[color:light-dark(#bae6fd,#0369a1)] bg-[color:light-dark(#f0f9ff,#082f4966)] text-[light-dark(#075985,#bae6fd)]",
          )}
        >
          {t(`document.badge.${badge}`)}
        </span>
      ) : required ? (
        <>
          <span aria-hidden> *</span>
          <span className="sr-only"> ({t("field.required")})</span>
        </>
      ) : (
        <span className="font-normal text-muted-foreground"> ({t("field.optional")})</span>
      )}
    </>
  );

  const control: ControlProps = { field, id, input, invalid: !!problem, describedBy, onInput, onBlur };

  let body: ReactNode;
  if (field.locked) {
    const value = stored ? toAnswerMap({ [field.key]: stored })[field.key] : undefined;
    const shown = displayValue(field, value, locale, "\n") || (stored && "image" in stored ? t("field.pictureAdded") : "");
    body = (
      <div role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy} className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-base">
        <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words">{shown || "-"}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("field.locked")}</p>
        </div>
      </div>
    );
  } else if (field.sensitive === true) {
    // an ID number or a bank account: hidden as it is typed (sensitive-control.tsx)
    body = <SensitiveControl {...control} />;
  } else {
    switch (field.type) {
      case "choice":
        body = <ChoiceControl {...control} />;
        break;
      case "multichoice":
        body = <MultichoiceControl {...control} />;
        break;
      case "yesno":
        body = <YesNoControl {...control} />;
        break;
      case "acknowledge":
        body = <AcknowledgeControl {...control} />;
        break;
      case "list":
        body = <ListControl {...control} />;
        break;
      case "file": {
        const files = stored && "files" in stored ? stored.files : [];
        const plain = <FileControl field={field} id={id} describedBy={describedBy} files={files} onUpload={onUpload} onRemoveUpload={onRemoveUpload} />;
        const made = files.find((f) => f.name === STAMP_FILE_NAME);
        body =
          field.stamp && definition && answers && onUpload ? (
            <StampChoice
              field={field}
              id={id}
              definition={definition}
              answers={answers}
              picture={null}
              savedName={made ? made.name : null}
              onGoToField={onGoToField}
              onRemove={() => {
                if (made && onRemoveUpload) void onRemoveUpload(field.key, made.id).catch(() => undefined);
              }}
              onUse={async ({ file }) => {
                try {
                  // a stamp made again replaces the one made before
                  if (made && onRemoveUpload) await onRemoveUpload(field.key, made.id);
                  await onUpload(field.key, file);
                  return true;
                } catch {
                  return false;
                }
              }}
            >
              {plain}
            </StampChoice>
          ) : (
            plain
          );
        break;
      }
      case "image": {
        const picture = typeof input.image === "string" && input.image ? input.image : null;
        body =
          field.stamp && definition && answers ? (
            <StampChoice
              field={field}
              id={id}
              definition={definition}
              answers={answers}
              picture={picture}
              onGoToField={onGoToField}
              onRemove={() => onInput({ image: "" })}
              onUse={async ({ dataUrl }) => {
                // the same answer a chosen picture gives: the page saves it, and the browser and the server check it as any picture
                onInput({ image: dataUrl });
                return true;
              }}
            >
              <ImageControl {...control} />
            </StampChoice>
          ) : (
            <ImageControl {...control} />
          );
        break;
      }
      default:
        body = <TextControl {...control} />;
    }
  }

  const tag = unconfirmed ? (
    <p className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2 py-1 text-xs font-medium text-foreground">
      <History className="size-3.5 shrink-0 text-amber-600" aria-hidden />
      {t("field.fromRecords")}
    </p>
  ) : null;

  const extras = (
    <>
      {help ? (
        <p id={helpId} className="text-sm text-muted-foreground">
          {help}
        </p>
      ) : null}
      {field.type === "phone" && !field.locked ? <p className="text-xs text-muted-foreground">{t("field.phoneHint")}</p> : null}
    </>
  );

  const message = problem ? (
    <p id={errorId} role="alert" className="text-sm font-medium text-destructive">
      {problem}
    </p>
  ) : null;

  const labelClass = "block text-base font-medium leading-snug";

  return (
    <div data-form-field={field.key} className="space-y-2">
      {group && !field.locked ? (
        <fieldset aria-describedby={describedBy} className="min-w-0 space-y-2">
          <legend className={cn(labelClass, "mb-2 max-w-full")}>{heading}</legend>
          {tag}
          {extras}
          {body}
        </fieldset>
      ) : (
        <>
          {field.locked ? (
            <p id={`${id}-label`} className={labelClass}>
              {heading}
            </p>
          ) : (
            <label htmlFor={id} className={labelClass}>
              {heading}
            </label>
          )}
          {tag}
          {extras}
          {body}
        </>
      )}
      {message}
    </div>
  );
}
