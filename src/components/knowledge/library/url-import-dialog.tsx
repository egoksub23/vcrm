'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import type { KbLanguage } from '@/lib/ai/knowledge-query';
import type { KnowledgeCollection } from '@/lib/knowledge-types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { ImportResults, ImportTargetFields } from './import-shared';
import { isHttpUrl, readImportedDrafts, type ImportedDraft } from './library-helpers';

/** "Import a web page": fetch a public page into a draft article with a link
 *  back to the source (re-sync later from the row menu). */
export function UrlImportDialog({
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
  const [url, setUrl] = useState('');
  const [language, setLanguage] = useState<KbLanguage>('en');
  const [collectionId, setCollectionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<ImportedDraft[] | null>(null);

  const valid = isHttpUrl(url);

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/knowledge/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'url',
          url: url.trim(),
          language,
          collection_id: collectionId || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('failed'));
        return;
      }
      setDrafts(readImportedDrafts(data));
      onImported();
    } catch {
      toast.error(t('failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('url.title')}</DialogTitle>
          <DialogDescription>{t('url.description')}</DialogDescription>
        </DialogHeader>

        {drafts ? (
          <ImportResults drafts={drafts} />
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              {t('url.label')}
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/help/refunds"
                inputMode="url"
                autoFocus
                disabled={busy}
              />
            </label>
            {url.trim() !== '' && !valid && <p className="-mt-2 text-xs text-destructive">{t('url.invalid')}</p>}
            <ImportTargetFields
              language={language}
              onLanguage={setLanguage}
              collectionId={collectionId}
              onCollection={setCollectionId}
              collections={collections}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">{t('url.resyncHint')}</p>
            <p className="text-xs text-muted-foreground">{t('draftsNotice')}</p>
          </form>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('close')}
          </Button>
          {!drafts && (
            <Button onClick={() => void submit()} disabled={busy || !valid}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {busy ? t('url.fetching') : t('url.submit')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
