'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FileUp, Loader2, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { KbLanguage } from '@/lib/ai/knowledge-query';
import type { KnowledgeCollection } from '@/lib/knowledge-types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

import { ImportResults, ImportTargetFields } from './import-shared';
import {
  IMPORT_EXTENSIONS,
  IMPORT_MAX_BYTES,
  formatBytes,
  isImportableFile,
  readImportedDrafts,
  type ImportedDraft,
} from './library-helpers';

/** "Upload a file": text, Markdown, CSV, Word or PDF. The server turns each
 *  file into draft articles; the dialog lists what was created. */
export function FileImportDialog({
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
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [language, setLanguage] = useState<KbLanguage>('en');
  const [collectionId, setCollectionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ drafts: ImportedDraft[]; skipped: number; errors: string[] } | null>(null);

  function addFiles(list: FileList | File[]) {
    const next: File[] = [];
    for (const f of Array.from(list)) {
      if (!isImportableFile(f.name)) toast.error(t('file.unsupported', { name: f.name }));
      else if (f.size > IMPORT_MAX_BYTES) toast.error(t('file.tooBig', { name: f.name, size: formatBytes(IMPORT_MAX_BYTES) }));
      else next.push(f);
    }
    if (next.length) setFiles((prev) => [...prev, ...next]);
  }

  async function submit() {
    if (files.length === 0 || busy) return;
    setBusy(true);
    const drafts: ImportedDraft[] = [];
    const errors: string[] = [];
    let skipped = 0;
    // One request per file, so one bad file (say an unsupported PDF) does not
    // sink the others, and its error can name it.
    for (const file of files) {
      try {
        const form = new FormData();
        form.set('kind', 'file');
        form.set('file', file);
        form.set('language', language);
        if (collectionId) form.set('collection_id', collectionId);
        const res = await fetch('/api/knowledge/import', { method: 'POST', body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          errors.push(`${file.name}: ${data.error ?? t('failed')}`);
          continue;
        }
        drafts.push(...readImportedDrafts(data));
        if (typeof data.skipped === 'number') skipped += data.skipped;
      } catch {
        errors.push(`${file.name}: ${t('failed')}`);
      }
    }
    setBusy(false);
    setResult({ drafts, skipped, errors });
    if (drafts.length > 0) onImported();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('file.title')}</DialogTitle>
          <DialogDescription>{t('file.description')}</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="grid gap-3">
            {result.drafts.length > 0 && <ImportResults drafts={result.drafts} skipped={result.skipped} />}
            {result.errors.length > 0 && (
              <ul className="grid gap-1 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {result.errors.map((e) => (
                  <li key={e} className="break-words">
                    {e}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="grid gap-4">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                addFiles(e.dataTransfer.files);
              }}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors',
                dragging ? 'border-primary bg-primary/5' : 'border-border',
              )}
            >
              <FileUp className="h-7 w-7 text-muted-foreground" />
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={IMPORT_EXTENSIONS.join(',')}
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
                {t('file.choose')}
              </Button>
              <p className="text-xs text-muted-foreground">{t('file.drop')}</p>
              <p className="text-xs text-muted-foreground">{t('file.accepted', { size: formatBytes(IMPORT_MAX_BYTES) })}</p>
            </div>

            {files.length > 0 && (
              <ul className="grid gap-1">
                {files.map((f, i) => (
                  <li
                    key={`${f.name}-${i}`}
                    className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      {f.name} <span className="text-xs text-muted-foreground">{formatBytes(f.size)}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                      disabled={busy}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label={t('file.remove', { name: f.name })}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <ImportTargetFields
              language={language}
              onLanguage={setLanguage}
              collectionId={collectionId}
              onCollection={setCollectionId}
              collections={collections}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">{t('file.csvNote')}</p>
            <p className="text-xs text-muted-foreground">{t('draftsNotice')}</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('close')}
          </Button>
          {!result && (
            <Button onClick={() => void submit()} disabled={busy || files.length === 0}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {busy ? t('file.importing') : t('file.submit', { count: files.length })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
