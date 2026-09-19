'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useCan } from '@/hooks/use-can';
import { detectLanguage, KB_LANGUAGES, KB_LANGUAGE_LABELS, type KbLanguage } from '@/lib/ai/knowledge-query';
import { MAX_CONTENT_CHARS, MAX_TITLE_CHARS, type KbKind } from '@/lib/ai/knowledge-doc';
import type { ArticleDraftSeed } from '@/lib/knowledge-types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

interface FullArticle {
  id: string;
  title: string;
  content: string;
  kind: KbKind;
  language: KbLanguage;
  status: 'draft' | 'published';
  use_in_ai: boolean;
  category: string | null;
  review_by: string | null;
  created_by: string | null;
}

const selectClass =
  'h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary/50 disabled:opacity-60';

/**
 * Create or edit one knowledge article. Used by the library page, the
 * chat's "Add to knowledge base" action and the unanswered-questions list.
 * The parent remounts it (via `key`) for every open, so its initial state
 * comes straight from `article` / `seed` with no reset effect.
 *
 * Admins choose Draft or Published. Everyone else always saves a draft an
 * admin will review — the server enforces that too.
 */
export function ArticleDialog({
  open,
  onOpenChange,
  article,
  seed,
  categories,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create a new article. */
  article: FullArticle | null;
  seed?: ArticleDraftSeed;
  /** Existing categories, offered as suggestions. */
  categories: string[];
  onSaved: (result: { id: string; status: 'draft' | 'published' }) => void;
}) {
  const t = useTranslations('Knowledge.dialog');
  const isAdmin = useCan('edit-settings');

  const [kind, setKind] = useState<KbKind>(article?.kind ?? seed?.kind ?? 'article');
  const [title, setTitle] = useState(article?.title ?? seed?.title ?? '');
  const [content, setContent] = useState(article?.content ?? seed?.content ?? '');
  const [language, setLanguage] = useState<KbLanguage>(
    article?.language ?? seed?.language ?? detectLanguage(`${seed?.title ?? ''} ${seed?.content ?? ''}`) ?? 'en',
  );
  const [category, setCategory] = useState(article?.category ?? '');
  const [reviewBy, setReviewBy] = useState(article?.review_by ?? '');
  const [useInAi, setUseInAi] = useState(article?.use_in_ai ?? true);
  const [publish, setPublish] = useState(article ? article.status === 'published' : isAdmin);
  const [saving, setSaving] = useState(false);

  const isQa = kind === 'qa';
  const canSave = title.trim().length > 0 && content.trim().length > 0 && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        content: content.trim(),
        kind,
        language,
        use_in_ai: useInAi,
        category: category.trim() || null,
        review_by: reviewBy || null,
      };
      if (isAdmin) body.status = publish ? 'published' : 'draft';
      if (!article && seed?.sourceConversationId) body.source_conversation_id = seed.sourceConversationId;

      const res = await fetch(article ? `/api/knowledge/${article.id}` : '/api/knowledge', {
        method: article ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      const status: 'draft' | 'published' = data.status ?? (isAdmin && publish ? 'published' : 'draft');
      if (data.warning) toast.warning(data.warning);
      else toast.success(!isAdmin ? t('savedForReview') : status === 'published' ? t('savedPublished') : t('savedDraft'));

      const id = (data.id as string | undefined) ?? article?.id ?? '';
      // Close the loop on an unanswered question this article answers.
      if (seed?.resolvesGapId && id) {
        void fetch(`/api/knowledge/gaps/${seed.resolvesGapId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'resolved', resolved_document_id: id }),
        });
      }
      onSaved({ id, status });
      onOpenChange(false);
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{article ? t('editTitle') : t('newTitle')}</DialogTitle>
          <DialogDescription>
            {isAdmin ? t('descriptionAdmin') : t('descriptionAgent')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="inline-flex rounded-lg border border-border bg-muted p-0.5 text-xs">
            {(['article', 'qa'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={
                  'rounded-md px-3 py-1 font-medium transition-colors ' +
                  (kind === k ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')
                }
              >
                {t(k === 'qa' ? 'kindQa' : 'kindArticle')}
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="kb-title">{isQa ? t('question') : t('titleLabel')}</Label>
            <Input
              id="kb-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={MAX_TITLE_CHARS}
              placeholder={isQa ? t('questionPlaceholder') : t('titlePlaceholder')}
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="kb-content">{isQa ? t('answer') : t('content')}</Label>
            <Textarea
              id="kb-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={MAX_CONTENT_CHARS}
              rows={9}
              placeholder={isQa ? t('answerPlaceholder') : t('contentPlaceholder')}
              disabled={saving}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="kb-language">{t('language')}</Label>
              <select
                id="kb-language"
                className={selectClass}
                value={language}
                onChange={(e) => setLanguage(e.target.value as KbLanguage)}
                disabled={saving}
              >
                {KB_LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {KB_LANGUAGE_LABELS[l]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kb-category">{t('category')}</Label>
              <Input
                id="kb-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                list="kb-categories"
                maxLength={60}
                placeholder={t('categoryPlaceholder')}
                disabled={saving}
              />
              <datalist id="kb-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kb-review">{t('reviewBy')}</Label>
              <Input
                id="kb-review"
                type="date"
                value={reviewBy}
                onChange={(e) => setReviewBy(e.target.value)}
                disabled={saving}
              />
            </div>
          </div>

          <label className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
            <span>
              <span className="block text-sm font-medium text-foreground">{t('useInAi')}</span>
              <span className="block text-xs text-muted-foreground">{t('useInAiHint')}</span>
            </span>
            <Switch checked={useInAi} onCheckedChange={setUseInAi} disabled={saving} />
          </label>

          {isAdmin ? (
            <label className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
              <span>
                <span className="block text-sm font-medium text-foreground">{t('publish')}</span>
                <span className="block text-xs text-muted-foreground">{t('publishHint')}</span>
              </span>
              <Switch checked={publish} onCheckedChange={setPublish} disabled={saving} />
            </label>
          ) : (
            <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{t('draftNotice')}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={!canSave}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
