"use client";

// A dialog to make a list of the workspace's own, or to change the name and description of a list. The key is made from the name
// when a list is made and never changes (forms name a list by its key); the dialog says so.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MAX_LIST_DESCRIPTION, MAX_LIST_NAME } from "@/lib/sign/lists/types";

import { Field } from "./shared";

export interface ListMetaDialogProps {
  /** The list being changed, or null to make one. */
  list: { key: string; name: string; description: string | null } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Store the values; resolves to a message to show, or null when it worked. */
  onSubmit: (values: { name: string; description: string }) => Promise<string | null>;
}

export function ListMetaDialog(props: ListMetaDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">{props.open ? <MetaForm key={props.list?.key ?? "new"} {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

function MetaForm({ list, onOpenChange, onSubmit }: ListMetaDialogProps) {
  const t = useTranslations("Sign.lists.meta");
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameMissing = name.trim() === "";

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (nameMissing) {
          setFailure(t("nameRequired"));
          return;
        }
        setSaving(true);
        setFailure(null);
        void onSubmit({ name: name.trim(), description: description.trim() }).then((problem) => {
          setSaving(false);
          if (problem) setFailure(problem);
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>{list ? t("editTitle") : t("newTitle")}</DialogTitle>
        <DialogDescription>{list ? t("keyFixed", { key: list.key }) : t("keyMade")}</DialogDescription>
      </DialogHeader>
      <Field id="list-name" label={t("name")}>
        <Input id="list-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_LIST_NAME} autoFocus aria-invalid={(failure !== null && nameMissing) || undefined} />
      </Field>
      <Field id="list-description" label={t("description")}>
        <Textarea id="list-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={MAX_LIST_DESCRIPTION} />
      </Field>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {list ? t("save") : t("create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
