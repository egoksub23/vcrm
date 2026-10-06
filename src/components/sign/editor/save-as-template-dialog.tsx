"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { errorMessageKey } from "@/lib/sign/client/layout";
import { createClient } from "@/lib/supabase/client";

import { FormRow, NativeSelect } from "./form-bits";

interface Category {
  id: string;
  name: string;
}

interface SaveAsTemplateDialogProps {
  documentId: string;
  defaultName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Send any waiting changes first. Resolves false when they could not be saved (the template would miss them). */
  beforeSubmit: () => Promise<boolean>;
}

/** Ask for a name and a category, then copy the prepared document into a new template. */
export function SaveAsTemplateDialog({ documentId, defaultName, open, onOpenChange, beforeSubmit }: SaveAsTemplateDialogProps) {
  const t = useTranslations("Sign.editor");
  const [name, setName] = useState(defaultName);
  const [categoryId, setCategoryId] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const { data } = await createClient().from("sign_categories").select("id, name").eq("archived", false).order("position", { ascending: true }).order("name", { ascending: true });
      if (!cancelled && data) setCategories(data as Category[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const submit = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await beforeSubmit())) {
        setError("unsaved");
        return;
      }
      const res = await signRequest<{ template: { id: string } }>(`/api/sign/documents/${documentId}/template`, { json: { name: name.trim(), categoryId: categoryId || null } });
      setCreatedId(res.template.id);
    } catch (err) {
      setError(err instanceof SignApiError ? err.code : "request_failed");
    } finally {
      setBusy(false);
    }
  };

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      // start fresh the next time
      setCreatedId(null);
      setError(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("template.title")}</DialogTitle>
          <DialogDescription>{createdId ? t("template.done") : t("template.intro")}</DialogDescription>
        </DialogHeader>
        {createdId ? (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              {t("common.close")}
            </Button>
            <Button render={<Link href={`/sign/templates/${createdId}`} />} nativeButton={false}>
              {t("template.open")}
            </Button>
          </DialogFooter>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <FormRow label={t("template.name")} htmlFor="sign-template-name">
              <Input id="sign-template-name" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} autoFocus />
            </FormRow>
            <FormRow label={t("template.category")} htmlFor="sign-template-category">
              <NativeSelect id="sign-template-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">{t("template.noCategory")}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </FormRow>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error === "unsaved" ? t("template.unsaved") : t(errorMessageKey(error))}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? t("template.saving") : t("template.save")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
