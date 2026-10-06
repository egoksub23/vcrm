"use client";

// "Delete this field / part?": says what else goes with it (the fields of a part, the boxes on the pages that print them, the
// rules that look at them), and that Undo brings it back until the form is saved.

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface DeleteConfirmDialogProps {
  /** What is being deleted; null closes the dialog. */
  kind: "field" | "part" | null;
  /** Its name, in the language the builder is showing. */
  name: string;
  fields: number;
  places: number;
  rules: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteConfirmDialog({ kind, name, fields, places, rules, onCancel, onConfirm }: DeleteConfirmDialogProps) {
  const t = useTranslations("Sign.formBuilder");
  return (
    <Dialog open={kind !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{kind === "part" ? t("confirm.partTitle", { name }) : t("confirm.fieldTitle", { name })}</DialogTitle>
          <DialogDescription>{t("confirm.body")}</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {kind === "part" ? <li>{t("confirm.fields", { count: fields })}</li> : null}
          {places > 0 ? <li>{t("confirm.places", { count: places })}</li> : null}
          {rules > 0 ? <li>{t("confirm.rules", { count: rules })}</li> : null}
        </ul>
        <p className="text-xs text-muted-foreground">{t("confirm.undo")}</p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("confirm.cancel")}
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            {t("confirm.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
