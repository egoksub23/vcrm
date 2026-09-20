'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import type { KbKind } from '@/lib/ai/knowledge-doc';
import type { KbLanguage } from '@/lib/ai/knowledge-query';
import type { ArticleDraftSeed, KnowledgeArticle } from '@/lib/knowledge-types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { KbEditorForm } from './editor/kb-editor-form';
import { canEditArticle } from './editor/kb-editor-utils';

/** What callers already pass for an existing article: only `id` is needed,
 *  because the dialog loads the whole article (rich text, attachments) itself. */
interface ArticleRef {
  id: string;
  title?: string;
  content?: string;
  kind?: KbKind;
  language?: KbLanguage;
  status?: 'draft' | 'published';
  use_in_ai?: boolean;
  category?: string | null;
  review_by?: string | null;
  created_by?: string | null;
}

/**
 * Create or edit one knowledge article in a dialog: the same editor as the
 * /knowledge/[id] page. Used by the chat's "Add to knowledge base" action and
 * the unanswered-questions list. The parent remounts it (via `key`) for every
 * open, so its state comes straight from `article` / `seed`.
 */
export function ArticleDialog({
  open,
  onOpenChange,
  article,
  seed,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create a new article. */
  article: ArticleRef | null;
  seed?: ArticleDraftSeed;
  /** Kept so existing callers compile; collections replaced free-text categories. */
  categories?: string[];
  onSaved: (result: { id: string; status: 'draft' | 'published' }) => void;
}) {
  const t = useTranslations('Knowledge.dialog');
  const te = useTranslations('Knowledge.editor');
  const { user } = useAuth();
  const isAdmin = useCan('edit-settings');
  const canWrite = useCan('send-messages');

  const [full, setFull] = useState<KnowledgeArticle | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const articleId = article?.id ?? null;

  // An existing article is fetched in full: callers may hold only a summary.
  useEffect(() => {
    if (!articleId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/knowledge/${articleId}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('load failed');
        const data = (await res.json()) as KnowledgeArticle;
        if (!cancelled) {
          setFull(data);
          setLoadFailed(false);
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [articleId, attempt]);

  const ready = !articleId || full !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{article ? t('editTitle') : t('newTitle')}</DialogTitle>
          <DialogDescription>{isAdmin ? t('descriptionAdmin') : t('descriptionAgent')}</DialogDescription>
        </DialogHeader>

        {ready ? (
          <KbEditorForm
            key={full ? `${full.id}-${full.updated_at}` : 'new'}
            article={full}
            seed={seed}
            variant="dialog"
            canEdit={canEditArticle({ isAdmin, canWrite, userId: user?.id ?? null, article: full })}
            onSaved={(result) => {
              onSaved(result);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
            // The restored text replaces what is open, so load it again.
            onRestored={() => setAttempt((n) => n + 1)}
          />
        ) : loadFailed ? (
          <div className="space-y-3 py-8 text-center">
            <p className="text-sm text-destructive">{te('loadFailed')}</p>
            <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
              {te('retry')}
            </Button>
          </div>
        ) : (
          <div className="flex justify-center py-16" role="status" aria-label={te('loading')}>
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
