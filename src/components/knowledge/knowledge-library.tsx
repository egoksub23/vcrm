'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { BookOpen, HelpCircle, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { cn } from '@/lib/utils';
import { KB_LANGUAGES, KB_LANGUAGE_LABELS } from '@/lib/ai/knowledge-query';
import type { ArticleDraftSeed, KnowledgeDocSummary } from '@/lib/knowledge-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { ArticleDialog } from './article-dialog';
import { KnowledgeGaps } from './knowledge-gaps';

type FullArticle = NonNullable<React.ComponentProps<typeof ArticleDialog>['article']>;

const chip = 'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap';
const selectClass =
  'h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary/50';

const isReviewDue = (d: KnowledgeDocSummary) =>
  !!d.review_by && d.review_by <= format(new Date(), 'yyyy-MM-dd');

/** The knowledge library page: every article, plus the queue of questions
 *  the AI could not answer. */
export function KnowledgeLibrary() {
  const t = useTranslations('Knowledge');
  const { user } = useAuth();
  const isAdmin = useCan('edit-settings');
  const canWrite = useCan('send-messages');

  const [docs, setDocs] = useState<KnowledgeDocSummary[]>([]);
  const [searchMode, setSearchMode] = useState<'meaning' | 'keyword'>('keyword');
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [lang, setLang] = useState('');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [dialog, setDialog] = useState<{
    key: number;
    article: FullArticle | null;
    seed?: ArticleDraftSeed;
  } | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [tab, setTab] = useState('articles');
  const [gapCount, setGapCount] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/knowledge', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      setDocs(data.documents ?? []);
      setSearchMode(data.search_mode === 'meaning' ? 'meaning' : 'keyword');
      setGapCount(data.open_gaps ?? 0);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const categories = useMemo(
    () => Array.from(new Set(docs.map((d) => d.category).filter((c): c is string => !!c))).sort(),
    [docs],
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return docs.filter((d) => {
      if (lang && d.language !== lang) return false;
      if (category && d.category !== category) return false;
      if (status === 'published' && d.status !== 'published') return false;
      if (status === 'draft' && d.status !== 'draft') return false;
      if (status === 'review' && !isReviewDue(d)) return false;
      if (status === 'agents' && d.use_in_ai) return false;
      if (needle && !`${d.title} ${d.category ?? ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [docs, q, lang, status, category]);

  const canManage = (d: KnowledgeDocSummary) =>
    isAdmin || (canWrite && d.status === 'draft' && d.created_by === user?.id);

  const openNew = (seed?: ArticleDraftSeed) => setDialog({ key: Date.now(), article: null, seed });

  async function openEdit(id: string) {
    try {
      const res = await fetch(`/api/knowledge/${id}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('openFailed'));
        return;
      }
      setDialog({ key: Date.now(), article: data as FullArticle });
    } catch {
      toast.error(t('openFailed'));
    }
  }

  async function remove(d: KnowledgeDocSummary) {
    if (!window.confirm(t('deleteConfirm', { title: d.title }))) return;
    const res = await fetch(`/api/knowledge/${d.id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error ?? t('deleteFailed'));
      return;
    }
    setDocs((prev) => prev.filter((x) => x.id !== d.id));
    toast.success(t('deleted'));
  }

  async function publish(d: KnowledgeDocSummary) {
    const res = await fetch(`/api/knowledge/${d.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'published' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error ?? t('publishFailed'));
      return;
    }
    if (data.warning) toast.warning(data.warning);
    else toast.success(t('published'));
    void load();
  }

  async function reindex() {
    setReindexing(true);
    try {
      const res = await fetch('/api/knowledge/reindex', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) toast.success(t('reindexed', { count: data.reindexed }));
      else toast.error(data.error ?? t('reindexFailed'));
    } catch {
      toast.error(t('reindexFailed'));
    } finally {
      setReindexing(false);
    }
  }

  const pendingReview = docs.filter((d) => d.status === 'draft').length;

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <BookOpen className="h-5 w-5 text-primary" /> {t('title')}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(chip, searchMode === 'meaning' ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}
            title={searchMode === 'meaning' ? t('searchModeMeaningHint') : t('searchModeKeywordHint')}
          >
            {searchMode === 'meaning' ? t('searchModeMeaning') : t('searchModeKeyword')}
          </span>
          {isAdmin && docs.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => void reindex()} disabled={reindexing} title={t('reindexHint')}>
              {reindexing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
              {t('reindex')}
            </Button>
          )}
          {canWrite && (
            <Button size="sm" onClick={() => openNew()}>
              <Plus className="mr-1.5 h-4 w-4" /> {t('add')}
            </Button>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="articles">
            <BookOpen className="mr-1.5 h-4 w-4" /> {t('tabArticles')}
          </TabsTrigger>
          <TabsTrigger value="gaps">
            <HelpCircle className="mr-1.5 h-4 w-4" /> {t('tabGaps')}
            {gapCount > 0 && (
              <span className={cn(chip, 'ml-1.5 bg-destructive/15 text-destructive')}>{gapCount}</span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="articles" className="mt-4 space-y-3">
          {isAdmin && pendingReview > 0 && (
            <button
              type="button"
              onClick={() => setStatus('draft')}
              className="w-full rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-sm text-amber-700 dark:text-amber-400"
            >
              {t('draftsWaiting', { count: pendingReview })}
            </button>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="h-9 max-w-xs"
              aria-label={t('searchPlaceholder')}
            />
            <select className={selectClass} value={lang} onChange={(e) => setLang(e.target.value)} aria-label={t('filterLanguage')}>
              <option value="">{t('allLanguages')}</option>
              {KB_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {KB_LANGUAGE_LABELS[l]}
                </option>
              ))}
            </select>
            <select className={selectClass} value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('filterStatus')}>
              <option value="">{t('allStatuses')}</option>
              <option value="published">{t('statusPublished')}</option>
              <option value="draft">{t('statusDraft')}</option>
              <option value="review">{t('reviewDue')}</option>
              <option value="agents">{t('audienceAgents')}</option>
            </select>
            {categories.length > 0 && (
              <select className={selectClass} value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('filterCategory')}>
                <option value="">{t('allCategories')}</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </div>

          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : docs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-10 text-center">
              <BookOpen className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium text-foreground">{t('emptyTitle')}</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t('emptyBody')}</p>
              {canWrite && (
                <Button className="mt-4" size="sm" onClick={() => openNew()}>
                  <Plus className="mr-1.5 h-4 w-4" /> {t('add')}
                </Button>
              )}
            </div>
          ) : shown.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{t('noMatches')}</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-muted text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('colTitle')}</th>
                    <th className="px-3 py-2 font-medium">{t('colLanguage')}</th>
                    <th className="px-3 py-2 font-medium">{t('colAudience')}</th>
                    <th className="px-3 py-2 font-medium">{t('colStatus')}</th>
                    <th className="px-3 py-2 text-right font-medium" title={t('colAiUsesHint')}>
                      {t('colAiUses')}
                    </th>
                    <th className="px-3 py-2 font-medium">{t('colUpdated')}</th>
                    <th className="w-24 px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shown.map((d) => (
                    <tr key={d.id} className="align-top hover:bg-muted/40">
                      <td className="max-w-[320px] px-3 py-2.5">
                        <button
                          type="button"
                          onClick={() => void openEdit(d.id)}
                          className="block max-w-full truncate text-left font-medium text-foreground hover:underline"
                        >
                          {d.title}
                        </button>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {d.kind === 'qa' ? t('kindQa') : t('kindArticle')}
                          {d.category ? ` · ${d.category}` : ''}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{KB_LANGUAGE_LABELS[d.language]}</td>
                      <td className="px-3 py-2.5">
                        <span className={cn(chip, d.use_in_ai ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
                          {d.use_in_ai ? t('audienceAi') : t('audienceAgents')}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {d.status === 'draft' ? (
                          <span className={cn(chip, 'bg-amber-500/15 text-amber-700 dark:text-amber-400')}>
                            {t('statusDraft')}
                          </span>
                        ) : isReviewDue(d) ? (
                          <span className={cn(chip, 'bg-amber-500/15 text-amber-700 dark:text-amber-400')}>
                            {t('reviewDue')}
                          </span>
                        ) : (
                          <span className={cn(chip, 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400')}>
                            {t('statusPublished')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                        {d.use_in_ai && d.status === 'published' ? d.ai_uses : '–'}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-xs text-muted-foreground">
                        {format(new Date(d.updated_at), 'MMM d, yyyy')}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          {isAdmin && d.status === 'draft' && (
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void publish(d)}>
                              {t('publish')}
                            </Button>
                          )}
                          {canManage(d) && (
                            <>
                              <button
                                type="button"
                                onClick={() => void openEdit(d.id)}
                                className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                aria-label={t('edit')}
                                title={t('edit')}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void remove(d)}
                                className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                                aria-label={t('delete')}
                                title={t('delete')}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="gaps" className="mt-4">
          <KnowledgeGaps
            canWrite={canWrite}
            onCount={setGapCount}
            onWrite={(seed) => openNew(seed)}
          />
        </TabsContent>
      </Tabs>

      {dialog && (
        <ArticleDialog
          key={dialog.key}
          open
          onOpenChange={(o) => {
            if (!o) setDialog(null);
          }}
          article={dialog.article}
          seed={dialog.seed}
          categories={categories}
          onSaved={() => void load()}
        />
      )}
    </div>
  );
}
