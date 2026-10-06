"use client";

// ============================================================
// Doc Sign, signing page: the sheet that opens over the page for one field. On a phone it rises from the
// bottom and fills most of the screen; on a larger screen it is a card in the middle. Focus goes into
// it, stays in it, and returns to where it came from when it closes (the sheet is a dialog).
// ============================================================

import { X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { PlacedField } from "@/lib/sign/pdf/types";
import type { AnswerInput } from "@/lib/sign/rules";
import type { Adopted } from "@/lib/sign/client/signer-flow";

import { DateEditor, DropdownEditor, PictureEditor, TextEditor } from "./simple-editors";
import { SignatureEditor } from "./signature-editor";

interface FieldSheetProps {
  /** The field being filled, or null when no sheet is open. */
  field: PlacedField | null;
  value: AnswerInput | undefined;
  signerName: string;
  adopted: Adopted | null;
  onApply: (field: PlacedField, input: AnswerInput, adopt: Adopted | null) => void;
  onClear: (field: PlacedField) => void;
  onClose: () => void;
}

/** The label a field is called by: the sender's own, or its kind. */
export function useFieldLabel(): (field: Pick<PlacedField, "type" | "label">) => string {
  const t = useTranslations("Sign.signer");
  return (field) => field.label?.trim() || t(`fieldTypes.${field.type}`);
}

export function FieldSheet({ field, value, signerName, adopted, onApply, onClear, onClose }: FieldSheetProps) {
  const t = useTranslations("Sign.signer");
  const labelOf = useFieldLabel();

  return (
    <Sheet open={field !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        // a field you type into gets the cursor at once; the other sheets start at the top
        initialFocus={() => document.querySelector<HTMLElement>("[data-sheet-autofocus]") ?? true}
        className="mx-auto max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))] motion-reduce:transition-none sm:max-w-lg"
      >
        {field ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <SheetTitle className="text-lg leading-snug">{labelOf(field)}</SheetTitle>
                <SheetDescription>{field.required ? t("sheet.required") : t("sheet.optional")}</SheetDescription>
              </div>
              <Button type="button" variant="ghost" className="size-11 shrink-0" onClick={onClose} aria-label={t("common.close")}>
                <X className="size-5" aria-hidden />
              </Button>
            </div>
            <Editor
              key={field.key}
              field={field}
              value={value}
              signerName={signerName}
              adopted={adopted}
              label={labelOf(field)}
              onApply={(input, adopt) => onApply(field, input, adopt)}
              onClear={() => onClear(field)}
            />
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Editor({
  field,
  value,
  signerName,
  adopted,
  label,
  onApply,
  onClear,
}: {
  field: PlacedField;
  value: AnswerInput | undefined;
  signerName: string;
  adopted: Adopted | null;
  label: string;
  onApply: (input: AnswerInput, adopt: Adopted | null) => void;
  onClear: () => void;
}) {
  const plain = { field, value, label, onApply: (input: AnswerInput) => onApply(input, null), onClear };
  switch (field.type) {
    case "signature":
    case "initials":
      return <SignatureEditor field={field} value={value} signerName={signerName} adopted={adopted} onApply={onApply} onClear={onClear} />;
    case "date":
      return <DateEditor {...plain} />;
    case "dropdown":
      return <DropdownEditor {...plain} />;
    case "upload":
      return <PictureEditor {...plain} />;
    default:
      return <TextEditor {...plain} />;
  }
}
