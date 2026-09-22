'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Upload, X } from 'lucide-react';

import type { KbLanguage } from '@/lib/ai/knowledge-query';
import type { KnowledgeCollection } from '@/lib/knowledge-types';
import {
  MAX_IMPORT_PAIRS,
  capPairs,
  parseCsvPairs,
  parsePastedPairs,
  type QaPair,
} from '@/lib/knowledge-import-parse';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

import { ImportResults, ImportTargetFields } from './import-shared';
import { readImportedDrafts, type ImportedDraft } from './library-helpers';

const PREVIEW_ROWS = 5;
/** A CSV is text; anything bigger than this is not a Q&A sheet. */
const CSV_MAX_BYTES = 2 * 1024 * 1024;

interface CsvState {
  name: string;
  pairs: QaPair[];
  skipped: number;
}

/** "Bulk import Q&A": paste "Question | Answer" lines or upload a CSV, look at
 *  the preview, and create one draft per pair. */
export function QaImportDialog({
  open,
  onOpenChange,
  collections,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collections: KnowledgeCollection[];
  onImported: () => void;
}) {
  const t = useTranslations('Knowledge.addContent');
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [csv, setCsv] = useState<CsvState | null>(null);
  const [language, setLanguage] = useState<KbLanguage>('en');
  const [collectionId, setCollectionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ drafts: ImportedDraft[]; skipped: number } | null>(null);

  const parsed = useMemo(() => {
    const base = csv ?? parsePastedPairs(text);
    const capped = capPairs(base.pairs);
    return { ...capped, skipped: base.skipped };
  }, [csv, text]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > CSV_MAX_BYTES) {
      toast.error(t('qa.csvError'));
      return;
    }
    try {
      const r = parseCsvPairs(await file.text());
      if (r.missingColumns) {
        toast.error(t('qa.csvColumns'));
        return;
      }
      setCsv({ name: file.name, pairs: r.pairs, skipped: r.skipped });
    } catch {
      toast.error(t('qa.csvError'));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function submit() {
    if (parsed.pairs.length === 0 || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/knowledge/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'qa',
          pairs: parsed.pairs,
          language,
          collection_id: collectionId || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('failed'));
        return;
      }
      setResult({ drafts: readImportedDrafts(data), skipped: typeof data.skipped === 'number' ? data.skipped : 0 });
      onImported();
    } catch {
      toast.error(t('failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('qa.title')}</DialogTitle>
          <DialogDescription>{t('qa.description')}</DialogDescription>
        </DialogHeader>

        {result ? (
          <ImportResults drafts={result.drafts} skipped={result.skipped} />
        ) : (
          <div className="grid gap-4">
            {csv ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{t('qa.csvLoaded', { name: csv.name, count: csv.pairs.length })}</span>
                <button
                  type="button"
                  onClick={() => setCsv(null)}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={t('qa.removeCsv')}
                  title={t('qa.removeCsv')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="grid gap-2">
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={t('qa.placeholder')}
                  rows={6}
                  aria-label={t('qa.pasteLabel')}
                  disabled={busy}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={(e) => void onFile(e.target.files?.[0])}
                  />
                  <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
                    <Upload className="mr-1.5 h-4 w-4" /> {t('qa.uploadCsv')}
                  </Button>
                  <span className="text-xs text-muted-foreground">{t('qa.csvHint')}</span>
                </div>
              </div>
            )}

            <div className="grid gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {parsed.pairs.length === 0 ? t('qa.none') : t('qa.found', { count: parsed.pairs.length })}
                {parsed.skipped > 0 ? ` · ${t('skipped', { count: parsed.skipped })}` : ''}
              </p>
              {parsed.truncated && <p className="text-xs text-amber-700 dark:text-amber-400">{t('qa.truncated', { max: MAX_IMPORT_PAIRS })}</p>}
              {parsed.pairs.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted text-left text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">{t('qa.question')}</th>
                        <th className="px-2 py-1.5 font-medium">{t('qa.answer')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {parsed.pairs.slice(0, PREVIEW_ROWS).map((p, i) => (
                        <tr key={i} className="align-top">
                          <td className="max-w-[200px] truncate px-2 py-1.5">{p.question}</td>
                          <td className="max-w-[260px] truncate px-2 py-1.5 text-muted-foreground">{p.answer}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {parsed.pairs.length > PREVIEW_ROWS && (
                    <p className="border-t border-border px-2 py-1.5 text-xs text-muted-foreground">
                      {t('qa.more', { count: parsed.pairs.length - PREVIEW_ROWS })}
                    </p>
                  )}
                </div>
              )}
            </div>

            <ImportTargetFields
              language={language}
              onLanguage={setLanguage}
              collectionId={collectionId}
              onCollection={setCollectionId}
              collections={collections}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">{t('draftsNotice')}</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('close')}
          </Button>
          {!result && (
            <Button onClick={() => void submit()} disabled={busy || parsed.pairs.length === 0}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {busy ? t('qa.creating') : t('qa.submit', { count: parsed.pairs.length })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
