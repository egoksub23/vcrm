"use client";

// New template from a file: drop or choose a PDF, a Word file or an image, optionally name it and put it in a
// category, and the server makes the template (a draft with no fields). Then the editor opens.
// Or a form WITHOUT a signature (migration 169): no file, a name, and the form builder opens. The choice is made here, once:
// a template is an agreement to sign or a form for good.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { FileText, Loader2, UploadCloud, X } from "lucide-react";

import { useAdminErrorText, Field, NativeSelect } from "@/components/settings/sign/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { adminErrorKey } from "@/lib/sign/client/admin-errors";
import { templateEditorHref } from "@/lib/sign/client/template-library";
import { MAX_UPLOAD_MB, UPLOAD_ACCEPT, checkUploadFile, formatBytes, isWordFile, titleFromFileName } from "@/lib/sign/client/upload";
import { cn } from "@/lib/utils";

import type { LibraryCategory } from "./use-template-library";

export function NewTemplateDialog({ open, onOpenChange, categories }: { open: boolean; onOpenChange: (open: boolean) => void; categories: LibraryCategory[] }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">{open ? <NewTemplateForm categories={categories} onClose={() => onOpenChange(false)} /> : null}</DialogContent>
    </Dialog>
  );
}

function NewTemplateForm({ categories, onClose }: { categories: LibraryCategory[]; onClose: () => void }) {
  const t = useTranslations("Sign.admin.library.new");
  const tErr = useTranslations("Sign.admin");
  const errorText = useAdminErrorText();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);

  const [kind, setKind] = useState<"file" | "form">("file");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [over, setOver] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = (f: File | null) => {
    if (!f) {
      setFile(null);
      setProblem(null);
      return;
    }
    const code = checkUploadFile(f);
    if (code) {
      setFile(null);
      setProblem(tErr(adminErrorKey(code)));
      return;
    }
    setFile(f);
    setProblem(null);
  };

  const submit = async () => {
    if (busy) return;
    if (kind === "form") {
      if (!name.trim()) return;
      setBusy(true);
      setProblem(null);
      try {
        const { template } = await signRequest<{ template: { id: string } }>("/api/sign/templates", { json: { mode: "form", name: name.trim(), ...(categoryId ? { categoryId } : {}) } });
        router.push(templateEditorHref(template.id, "form"));
      } catch (err) {
        setProblem(err instanceof SignApiError ? errorText(err) : tErr("errors.generic"));
        setBusy(false);
      }
      return;
    }
    if (!file) return;
    setBusy(true);
    setProblem(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      if (name.trim()) form.append("name", name.trim());
      if (categoryId) form.append("categoryId", categoryId);
      const { template } = await signRequest<{ template: { id: string } }>("/api/sign/templates", { form });
      router.push(templateEditorHref(template.id));
    } catch (err) {
      setProblem(err instanceof SignApiError ? errorText(err) : tErr("errors.generic"));
      setBusy(false);
    }
  };

  const options = [{ value: "", label: t("noCategory") }, ...categories.filter((c) => !c.archived).map((c) => ({ value: c.id, label: c.name }))];

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription>{t(kind === "form" ? "introForm" : "intro")}</DialogDescription>
      </DialogHeader>

      <fieldset className="grid gap-2 sm:grid-cols-2" disabled={busy}>
        <legend className="sr-only">{t("kindLegend")}</legend>
        {(["file", "form"] as const).map((k) => (
          <label key={k} className={cn("flex cursor-pointer flex-col gap-0.5 rounded-lg border p-3 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring", kind === k ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40")}>
            <span className="flex items-center gap-2 font-medium text-foreground">
              <input type="radio" name="new-template-kind" className="size-4" checked={kind === k} onChange={() => setKind(k)} />
              {t(k === "form" ? "kindForm" : "kindFile")}
            </span>
            <span className="pl-6 text-xs text-muted-foreground">{t(k === "form" ? "kindFormHint" : "kindFileHint")}</span>
          </label>
        ))}
      </fieldset>

      {kind === "form" ? null : file ? (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-background p-3">
          <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{file.name}</p>
            <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("removeFile")} disabled={busy} onClick={() => choose(null)}>
            <X aria-hidden />
          </Button>
        </div>
      ) : (
        <div
          className={cn("flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors", over ? "border-primary bg-primary/5" : "border-border")}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            choose(e.dataTransfer.files?.[0] ?? null);
          }}
        >
          <UploadCloud className="size-7 text-muted-foreground" aria-hidden />
          <p className="text-sm text-foreground">
            {t("dropHere")}{" "}
            <button type="button" className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline" onClick={() => input.current?.click()}>
              {t("chooseFile")}
            </button>
          </p>
          <p className="text-xs text-muted-foreground">{t("fileTypes", { max: MAX_UPLOAD_MB })}</p>
          <input
            ref={input}
            type="file"
            accept={UPLOAD_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-label={t("chooseFile")}
            onChange={(e) => {
              choose(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
        </div>
      )}

      {kind === "file" && file && isWordFile(file.name) ? <p className="text-xs text-muted-foreground">{t("wordNote")}</p> : null}

      <Field id="new-template-name" label={t("name")} hint={t("nameHint")}>
        <Input id="new-template-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder={kind === "file" && file ? titleFromFileName(file.name) : ""} disabled={busy} aria-describedby="new-template-name-hint" />
      </Field>
      <Field id="new-template-category" label={t("category")}>
        <NativeSelect id="new-template-category" value={categoryId} onChange={setCategoryId} options={options} disabled={busy} />
      </Field>

      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={busy || (kind === "form" ? !name.trim() : !file)}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {busy ? t("creating") : t("create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
