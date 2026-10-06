"use client";

// A dialog to create or change a category. The key is made from the name when the category is created and is
// never changed afterwards (documents and add-ons refer to it); the form shows it but cannot edit it.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatReminderDays, parseCategoryForm, type CategoryFormField, type CategoryValues, type SignCategoryRow } from "@/lib/sign/client/admin-settings";
import { SIGN_LOCALES } from "@/lib/sign/types";

import { Field } from "./shared";

export interface CategoryDialogProps {
  /** The category being changed, or null to create one. */
  category: SignCategoryRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Store the values; resolves to an error message to show, or null when it worked. */
  onSubmit: (values: CategoryValues) => Promise<string | null>;
}

export function CategoryDialog(props: CategoryDialogProps) {
  // the form starts again from the category each time the dialog opens for another one
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">{props.open ? <CategoryForm key={props.category?.id ?? "new"} {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

function CategoryForm({ category, onOpenChange, onSubmit }: CategoryDialogProps) {
  const t = useTranslations("Sign.admin.categories");
  const tLang = useTranslations("Sign.admin.languages");

  const [name, setName] = useState(category?.name ?? "");
  const [description, setDescription] = useState(category?.description ?? "");
  const [expiry, setExpiry] = useState(category?.expiry_days != null ? String(category.expiry_days) : "");
  const [reminders, setReminders] = useState(formatReminderDays(category?.reminder_days));
  const [codeRequired, setCodeRequired] = useState(category?.code_required ?? false);
  const [signInOrder, setSignInOrder] = useState(category?.sign_in_order ?? false);
  const [retention, setRetention] = useState(category?.retention_years != null ? String(category.retention_years) : "");
  const [consent, setConsent] = useState<Record<string, string>>({ ...(category?.consent_text ?? {}) });
  const [errors, setErrors] = useState<Partial<Record<CategoryFormField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const parsed = parseCategoryForm({ name, description, expiry, reminders, codeRequired, signInOrder, retention, consent });
    if (!parsed.ok) {
      setErrors(parsed.errors);
      setFailure(null);
      return;
    }
    setErrors({});
    setSaving(true);
    const problem = await onSubmit(parsed.values);
    setSaving(false);
    if (problem) setFailure(problem);
  };

  const err = (f: CategoryFormField) => (errors[f] ? t(`errors.${errors[f]}`) : null);

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{category ? t("editTitle") : t("newTitle")}</DialogTitle>
        <DialogDescription>{t("dialogIntro")}</DialogDescription>
      </DialogHeader>

      <Field id="cat-name" label={t("name")} error={err("name")}>
        <Input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus aria-invalid={!!errors.name} />
      </Field>
      {category ? (
        <p className="-mt-2 text-xs text-muted-foreground">{t("keyFixed", { key: category.key })}</p>
      ) : (
        <p className="-mt-2 text-xs text-muted-foreground">{t("keyMade")}</p>
      )}

      <Field id="cat-description" label={t("description")} error={err("description")}>
        <Textarea id="cat-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="cat-expiry" label={t("expiry")} hint={t("blankIsDefault")} error={err("expiry")}>
          <Input id="cat-expiry" inputMode="numeric" value={expiry} onChange={(e) => setExpiry(e.target.value)} placeholder={t("workspaceDefault")} aria-invalid={!!errors.expiry} aria-describedby="cat-expiry-hint" />
        </Field>
        <Field id="cat-reminders" label={t("reminders")} hint={t("blankIsDefault")} error={err("reminders")}>
          <Input id="cat-reminders" value={reminders} onChange={(e) => setReminders(e.target.value)} placeholder={t("workspaceDefault")} aria-invalid={!!errors.reminders} aria-describedby="cat-reminders-hint" />
        </Field>
        <Field id="cat-retention" label={t("retention")} hint={t("retentionHint")} error={err("retention")}>
          <Input id="cat-retention" inputMode="numeric" value={retention} onChange={(e) => setRetention(e.target.value)} placeholder={t("workspaceDefault")} aria-invalid={!!errors.retention} aria-describedby="cat-retention-hint" />
        </Field>
      </div>

      <div className="space-y-3">
        <ToggleRow id="cat-code" label={t("code")} hint={t("codeHint")} checked={codeRequired} onChange={setCodeRequired} />
        <ToggleRow id="cat-order" label={t("order")} hint={t("orderHint")} checked={signInOrder} onChange={setSignInOrder} />
      </div>

      <details className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">{t("consentTitle")}</summary>
        <p className="mt-2 text-xs text-muted-foreground">{t("consentHint")}</p>
        <div className="mt-3 space-y-3">
          {SIGN_LOCALES.map((l) => (
            <Field key={l} id={`cat-consent-${l}`} label={tLang(l)}>
              <Textarea id={`cat-consent-${l}`} value={consent[l] ?? ""} onChange={(e) => setConsent((c) => ({ ...c, [l]: e.target.value }))} rows={3} maxLength={2000} placeholder={t("consentPlaceholder")} />
            </Field>
          ))}
        </div>
      </details>

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
          {category ? t("save") : t("create")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ToggleRow({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-label={label} className="mt-0.5" />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}
