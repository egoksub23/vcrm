"use client";

// A dialog to load a CSV file into a list (the way to bring in the full MSIC list or a long list of banks). Choosing a file
// shows what it would do (how many items are new, changed, unchanged, removed, and every row that cannot be used and why);
// nothing is written until the person confirms. A row with a problem is left out, never half applied.

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SignApiError } from "@/lib/sign/client/api";
import { importProblemKey, listErrorKey } from "@/lib/sign/client/list-edit";
import { importList } from "@/lib/sign/client/lists-api";
import type { ImportResult, OptionListRow } from "@/lib/sign/lists/types";

const MAX_FILE_BYTES = 2_000_000;
const SHOWN_PROBLEMS = 20;

export interface ListImportDialogProps {
  list: Pick<OptionListRow, "key" | "name" | "kind" | "is_system">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (list: OptionListRow | undefined) => void;
}

export function ListImportDialog(props: ListImportDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">{props.open ? <ImportForm {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

type Mode = "merge" | "replace";

function ImportForm({ list, onOpenChange, onImported }: ListImportDialogProps) {
  const t = useTranslations("Sign.lists.import");
  const tErr = useTranslations("Sign.lists");
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [mode, setMode] = useState<Mode>("merge");
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; problems: { row: number; code: string; detail?: string }[] } | null>(null);

  const words = (err: unknown) => {
    const code = err instanceof SignApiError ? err.code : null;
    // a file that cannot be used at all says why, row 0
    const problems = err instanceof SignApiError ? err.issues.map((i) => ({ row: Number(i.field ?? 0), code: i.code, detail: i.detail })) : [];
    return { message: tErr(listErrorKey(code)), problems };
  };

  async function run(csv: string, how: Mode) {
    setBusy(true);
    setFailure(null);
    setPreview(null);
    try {
      setPreview(await importList(list.key, { csv, mode: how, dryRun: true }));
    } catch (err) {
      setFailure(words(err));
    } finally {
      setBusy(false);
    }
  }

  async function choose(f: File | undefined) {
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) {
      setFile(null);
      setPreview(null);
      setFailure({ message: tErr("errors.body_too_large"), problems: [] });
      return;
    }
    const csv = await f.text();
    setFile({ name: f.name, csv });
    await run(csv, mode);
  }

  async function apply() {
    if (!file) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await importList(list.key, { csv: file.csv, mode });
      onImported(result.list);
      onOpenChange(false);
    } catch (err) {
      setFailure(words(err));
      setBusy(false);
    }
  }

  /** One problem as a line: "Row 3: ..." for a row, the sentence alone for the file as a whole. */
  const say = (p: { row: number; code: string; detail?: string }) => `${p.row > 0 ? `${t("row", { row: p.row })} ` : ""}${tErr(importProblemKey(p.code), { row: p.row, detail: p.detail ?? "" })}`;
  const changes = preview ? preview.added + preview.updated + preview.removed : 0;
  const errors = preview?.problems.filter((p) => p.level === "error") ?? [];
  const warnings = preview?.problems.filter((p) => p.level === "warning") ?? [];

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t("title", { name: list.name })}</DialogTitle>
        <DialogDescription>{list.kind === "msic" ? t("introMsic") : t("intro")}</DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <input ref={input} id="list-import-file" type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => void choose(e.target.files?.[0])} />
        <Button type="button" variant="outline" onClick={() => input.current?.click()} disabled={busy}>
          <Upload aria-hidden />
          {file ? t("chooseOther") : t("choose")}
        </Button>
        {file ? <p className="text-sm text-muted-foreground">{t("file", { name: file.name })}</p> : null}
        <p className="text-xs text-muted-foreground">{t("format")}</p>
      </div>

      <fieldset className="space-y-1.5" disabled={busy}>
        <legend className="text-sm font-medium">{t("mode")}</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="import-mode"
            checked={mode === "merge"}
            className="mt-0.5 size-4 accent-[var(--primary)]"
            onChange={() => {
              setMode("merge");
              if (file) void run(file.csv, "merge");
            }}
          />
          <span>
            {t("modeMerge")}
            <span className="block text-xs text-muted-foreground">{t("modeMergeHint")}</span>
          </span>
        </label>
        {list.is_system ? (
          <p className="pl-6 text-xs text-muted-foreground">{t("systemMergeOnly")}</p>
        ) : (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="import-mode"
              checked={mode === "replace"}
              className="mt-0.5 size-4 accent-[var(--primary)]"
              onChange={() => {
                setMode("replace");
                if (file) void run(file.csv, "replace");
              }}
            />
            <span>
              {t("modeReplace")}
              <span className="block text-xs text-muted-foreground">{t("modeReplaceHint")}</span>
            </span>
          </label>
        )}
      </fieldset>

      {busy && !preview ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("checking")}
        </p>
      ) : null}

      {failure ? (
        <div role="alert" className="space-y-1 text-sm text-destructive">
          <p>{failure.message}</p>
          {failure.problems.length > 0 ? (
            <ul className="list-disc pl-5 text-xs">
              {failure.problems.slice(0, SHOWN_PROBLEMS).map((p, i) => (
                <li key={i}>{say(p)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {preview ? (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-sm" aria-live="polite">
          <p className="font-medium">{t("summary", { added: preview.added, updated: preview.updated, unchanged: preview.unchanged, removed: preview.removed })}</p>
          {mode === "replace" && preview.removed > 0 ? <p className="text-xs text-amber-700 dark:text-amber-400">{t("removedWarning", { count: preview.removed })}</p> : null}
          {errors.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-destructive">{t("skipped", { count: errors.length })}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {errors.slice(0, SHOWN_PROBLEMS).map((p, i) => (
                  <li key={i}>{say(p)}</li>
                ))}
                {errors.length > SHOWN_PROBLEMS ? <li>{t("moreProblems", { count: errors.length - SHOWN_PROBLEMS })}</li> : null}
              </ul>
            </div>
          ) : null}
          {warnings.length > 0 ? (
            <div>
              <p className="text-xs font-medium">{t("changed", { count: warnings.length })}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {warnings.slice(0, 5).map((p, i) => (
                  <li key={i}>{say(p)}</li>
                ))}
                {warnings.length > 5 ? <li>{t("moreProblems", { count: warnings.length - 5 })}</li> : null}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy && !!preview}>
          {t("cancel")}
        </Button>
        <Button type="button" onClick={() => void apply()} disabled={busy || !preview || changes === 0}>
          {busy && preview ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("apply")}
        </Button>
      </DialogFooter>
    </div>
  );
}
