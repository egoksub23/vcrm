"use client";

// A dialog to add an item to a list or to change one: its wording in each language (English is required; a language left empty
// reads as English), and for a new item its value. The value is what answers and forms store, so it cannot be changed once the
// item exists. For the MSIC list the value is the five-digit code.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { draftOf, draftProblems, emptyDraft, itemFromDraft, type ItemDraft } from "@/lib/sign/client/list-edit";
import { MAX_ITEM_LABEL, type ListItem, type ListKind } from "@/lib/sign/lists/types";

import { Field } from "./shared";

export interface ListItemDialogProps {
  /** The item being changed, or null to add one. */
  item: ListItem | null;
  kind: ListKind;
  /** Values already in the list. */
  taken: ReadonlySet<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Store the item; resolves to a message to show, or null when it worked. */
  onSubmit: (item: ListItem) => Promise<string | null>;
}

export function ListItemDialog(props: ListItemDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">{props.open ? <ItemForm key={props.item?.value ?? "new"} {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

const LANGS = ["en", "ms", "zh", "ko"] as const;
const VALUE_PROBLEMS = ["empty_value", "bad_value", "bad_msic_code", "duplicate_value"];

function ItemForm({ item, kind, taken, onOpenChange, onSubmit }: ListItemDialogProps) {
  const t = useTranslations("Sign.lists");
  const tLang = useTranslations("Sign.admin.languages");
  const [draft, setDraft] = useState<ItemDraft>(item ? draftOf(item) : emptyDraft());
  const [problems, setProblems] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<ItemDraft>) => setDraft((d) => ({ ...d, ...patch }));
  /** The first problem among `codes`, worded. */
  const err = (...codes: string[]): string | null => {
    const hit = problems.find((p) => codes.includes(p));
    return hit ? t(`errors.${hit}`) : null;
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const found = draftProblems(draft, kind, taken, item === null);
        setProblems(found);
        if (found.length > 0) return;
        setSaving(true);
        setFailure(null);
        void onSubmit(itemFromDraft(draft, item ?? undefined)).then((problem) => {
          setSaving(false);
          if (problem) setFailure(problem);
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>{item ? t("item.editTitle") : t("item.newTitle")}</DialogTitle>
        <DialogDescription>{item ? t("item.valueFixed") : kind === "msic" ? t("item.valueHintMsic") : t("item.valueHint")}</DialogDescription>
      </DialogHeader>

      <Field id="item-value" label={t("item.value")} error={err(...VALUE_PROBLEMS)}>
        <Input
          id="item-value"
          value={draft.value}
          disabled={item !== null}
          maxLength={60}
          className="font-mono"
          autoFocus={item === null}
          aria-invalid={problems.some((p) => VALUE_PROBLEMS.includes(p)) || undefined}
          onChange={(e) => set({ value: e.target.value })}
        />
      </Field>

      {LANGS.map((lang) => (
        <Field
          key={lang}
          id={`item-${lang}`}
          label={lang === "en" ? t("item.labelEn") : t("item.labelIn", { language: tLang(lang) })}
          hint={lang === "en" ? undefined : t("item.fallsBack")}
          error={lang === "en" ? err("empty_label", "label_too_long") : null}
        >
          <Input
            id={`item-${lang}`}
            value={draft[lang]}
            maxLength={MAX_ITEM_LABEL}
            autoFocus={item !== null && lang === "en"}
            aria-invalid={(lang === "en" && problems.includes("empty_label")) || undefined}
            onChange={(e) => set({ [lang]: e.target.value } as Partial<ItemDraft>)}
          />
        </Field>
      ))}

      <Field id="item-group" label={t("item.group")} hint={t("item.groupHint")} error={err("group_too_long")}>
        <Input id="item-group" value={draft.group} maxLength={40} onChange={(e) => set({ group: e.target.value })} />
      </Field>

      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
          {t("item.cancel")}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {item ? t("item.save") : t("item.add")}
        </Button>
      </DialogFooter>
    </form>
  );
}
