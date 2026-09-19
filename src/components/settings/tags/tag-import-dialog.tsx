'use client';

import { useMemo, useRef, useState } from 'react';
import { Download, FileUp, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { downloadCsv } from '@/lib/csv';
import { createClient } from '@/lib/supabase/client';
import {
  MAX_IMPORT_ROWS,
  TAG_NAME_MAX,
  parseTagCsv,
  planTagImport,
  tagsCsvTemplate,
  type ParseTagCsvResult,
  type TagKind,
} from '@/lib/tags/tag-csv';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Tag } from '@/types';

const INSERT_CHUNK = 200;
const UPDATE_CONCURRENCY = 10;
const PREVIEW_ISSUES = 8;

/**
 * CSV import for tags / conversation labels: pick a file, review what
 * will happen (create / update / skip), confirm. Remounted per open by
 * the parent so it always starts clean.
 */
export function TagImportDialog({
  open,
  onOpenChange,
  kind,
  existing,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: TagKind;
  /** Every tag in the account — names are unique across both lists. */
  existing: Tag[];
  onDone: () => void;
}) {
  const t = useTranslations('Settings.tagCatalog');
  const { user, accountId } = useAuth();
  const fileInput = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParseTagCsvResult | null>(null);
  const [importing, setImporting] = useState(false);

  const other = kind === 'tag' ? 'label' : 'tag';

  const plan = useMemo(
    () =>
      parsed
        ? planTagImport(
            existing.map((tag) => ({
              id: tag.id,
              name: tag.name,
              description: tag.description ?? null,
              color: tag.color,
              for_contacts: tag.for_contacts !== false,
              for_conversations: tag.for_conversations !== false,
            })),
            parsed.rows,
            kind,
          )
        : null,
    [parsed, existing, kind],
  );

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    try {
      setParsed(parseTagCsv(await file.text()));
    } catch (err) {
      console.error('[TagImportDialog] read failed:', err);
      setParsed(null);
      toast.error(t('import.readFailed'));
    }
  }

  const colorInvalidCount = parsed?.rows.filter((r) => r.colorInvalid).length ?? 0;
  const changes = plan ? plan.create.length + plan.update.length : 0;

  async function handleImport() {
    if (!plan || !user || !accountId || changes === 0) return;
    setImporting(true);
    const supabase = createClient();
    let failed = 0;

    for (let i = 0; i < plan.create.length; i += INSERT_CHUNK) {
      const chunk = plan.create.slice(i, i + INSERT_CHUNK).map((row) => ({
        ...row,
        user_id: user.id,
        account_id: accountId,
      }));
      const { error } = await supabase.from('tags').insert(chunk);
      if (error) {
        console.error('[TagImportDialog] insert failed:', error);
        failed += chunk.length;
      }
    }

    for (let i = 0; i < plan.update.length; i += UPDATE_CONCURRENCY) {
      const results = await Promise.all(
        plan.update
          .slice(i, i + UPDATE_CONCURRENCY)
          .map((u) => supabase.from('tags').update(u.patch).eq('id', u.id)),
      );
      for (const { error } of results) {
        if (error) {
          console.error('[TagImportDialog] update failed:', error);
          failed++;
        }
      }
    }

    setImporting(false);
    const done = changes - failed;
    if (failed > 0) {
      toast.error(t('import.partial', { done, failed }));
    } else {
      toast.success(t('import.done', { created: plan.create.length, updated: plan.update.length }));
    }
    onDone();
    if (failed === 0) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (importing ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(`${kind}.importTitle`)}</DialogTitle>
          <DialogDescription>{t('import.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                handleFile(e.target.files?.[0]);
                // Allow re-picking the same file after fixing it.
                e.target.value = '';
              }}
            />
            <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={importing}>
              <FileUp className="size-4" />
              {fileName ? t('import.chooseAnother') : t('import.chooseFile')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => downloadCsv(`${t(`${kind}.fileName`)}-template.csv`, tagsCsvTemplate(kind))}
            >
              <Download className="size-4" />
              {t('import.downloadTemplate')}
            </Button>
            {fileName ? (
              <span className="truncate text-xs text-muted-foreground">{fileName}</span>
            ) : null}
          </div>

          {parsed && plan ? (
            <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
              {parsed.rows.length === 0 ? (
                <p className="text-muted-foreground">{t('import.nothing')}</p>
              ) : (
                <ul className="space-y-1">
                  <li>{t('import.toCreate', { count: plan.create.length })}</li>
                  <li>{t('import.toUpdate', { count: plan.update.length })}</li>
                  <li className="text-muted-foreground">
                    {t('import.unchanged', { count: plan.unchanged })}
                  </li>
                  {plan.linkedFromOtherList > 0 ? (
                    <li className="text-muted-foreground">
                      {t('import.linked', { count: plan.linkedFromOtherList, other: t(`${other}.singular`) })}
                    </li>
                  ) : null}
                </ul>
              )}

              {colorInvalidCount > 0 ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {t('import.colorInvalid', { count: colorInvalidCount })}
                </p>
              ) : null}
              {parsed.tooManyRows ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {t('import.tooMany', { max: MAX_IMPORT_ROWS })}
                </p>
              ) : null}

              {parsed.issues.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-destructive">
                    {t('import.skipped', { count: parsed.issues.length })}
                  </p>
                  <ul className="max-h-28 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
                    {parsed.issues.slice(0, PREVIEW_ISSUES).map((issue) => (
                      <li key={`${issue.line}-${issue.reason}`}>
                        {t(`import.issue.${issue.reason}`, {
                          line: issue.line,
                          name: issue.name ?? '',
                          max: TAG_NAME_MAX,
                        })}
                      </li>
                    ))}
                    {parsed.issues.length > PREVIEW_ISSUES ? (
                      <li>{t('import.moreIssues', { count: parsed.issues.length - PREVIEW_ISSUES })}</li>
                    ) : null}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={importing}>
            {t('cancel')}
          </Button>
          <Button onClick={handleImport} disabled={importing || changes === 0}>
            {importing ? <Loader2 className="size-4 animate-spin" /> : null}
            {importing ? t('import.importing') : t('import.action', { count: changes })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
