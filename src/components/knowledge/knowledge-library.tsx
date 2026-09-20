'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { BookOpen, Loader2, RefreshCw } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useCapability } from '@/hooks/use-can';
import { cn } from '@/lib/utils';
import { KB_LANGUAGES, KB_LANGUAGE_LABELS, type KbLanguage } from '@/lib/ai/knowledge-query';
import { canTranslateArticle } from '@/lib/knowledge/translate';
import type { KnowledgeCollection, KnowledgeDocSummary, KnowledgeLibraryResponse } from '@/lib/knowledge-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

import { createdArticleId } from './translate-client';
import { useTranslate } from './use-translate';
import { KnowledgeGaps } from './knowledge-gaps';
import { AddContentMenu } from './library/add-content-menu';
import { ArticleTable } from './library/article-table';
import { CollectionsDialog } from './library/collections-dialog';
import { selectClass } from './library/import-shared';
import { InsightsView } from './library/insights-view';
import { LibraryRail } from './library/library-rail';
import { collectionIdOfView, countDocs, filterDocs, isListView, type LibraryView } from './library/library-helpers';

const chip = 'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap';

function StatTile({
  label,
  value,
  onClick,
  urgent,
}: {
  label: string;
  value: number;
  onClick?: () => void;
  urgent?: boolean;
}) {
  const body = (
    <>
      <span className={cn('block text-2xl font-semibold tabular-nums', urgent ? 'text-destructive' : 'text-foreground')}>
        {value}
      </span>
      <span className="mt-0.5 block text-xs text-muted-foreground">{label}</span>
    </>
  );
  const cls = 'rounded-xl border border-border bg-card p-3 text-left';
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, 'transition-colors hover:bg-muted/50')}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** The knowledge library page: a rail of collections and views, the stats,
 *  and the table of articles, plus the unanswered questions and insights. */
export function KnowledgeLibrary() {
  const t = useTranslations('Knowledge');
  const tl = useTranslations('Knowledge.library');
  const tt = useTranslations('Knowledge.translations');
  const router = useRouter();
  const translate = useTranslate();
  const { user } = useAuth();
  // knowledge.publish: publish, and edit / delete anyone's article.
  // knowledge.manage: collections and re-indexing. knowledge.draft: write
  // and edit your own drafts.
  const canPublish = useCapability('knowledge.publish');
  const canManageKb = useCapability('knowledge.manage');
  const canWrite = useCapability('knowledge.draft');

  const [docs, setDocs] = useState<KnowledgeDocSummary[]>([]);
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [searchMode, setSearchMode] = useState<'meaning' | 'keyword'>('keyword');
  const [windowDays, setWindowDays] = useState(30);
  const [aiAnswers, setAiAnswers] = useState(0);
  const [openGaps, setOpenGaps] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const [view, setView] = useState<LibraryView>('all');
  const [q, setQ] = useState('');
  const [lang, setLang] = useState('');
  const [reindexing, setReindexing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [showTranslations, setShowTranslations] = useState(false);
  const [translatingKey, setTranslatingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/knowledge', { cache: 'no-store' });
      const data = (await res.json().catch(() => ({}))) as Partial<KnowledgeLibraryResponse> & { error?: string };
      if (!res.ok) {
        setLoadFailed(true);
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      setDocs(data.documents ?? []);
      setCollections(data.collections ?? []);
      setSearchMode(data.search_mode === 'meaning' ? 'meaning' : 'keyword');
      setWindowDays(data.use_window_days ?? 30);
      setAiAnswers(data.ai_answers_30d ?? 0);
      setOpenGaps(data.open_gaps ?? 0);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const today = format(new Date(), 'yyyy-MM-dd');
  const counts = useMemo(() => countDocs(docs, today), [docs, today]);
  const shown = useMemo(
    () => filterDocs(docs, { view, language: lang, query: q, today, showTranslations }),
    [docs, view, lang, q, today, showTranslations],
  );
  const titleById = useMemo(() => new Map(docs.map((d) => [d.id, d.title])), [docs]);

  // A collection that was deleted while it was selected has nothing to show.
  const viewCollectionId = collectionIdOfView(view);
  useEffect(() => {
    if (viewCollectionId && !loading && !collections.some((c) => c.id === viewCollectionId)) setView('all');
  }, [viewCollectionId, collections, loading]);

  const canManage = (d: KnowledgeDocSummary) =>
    canPublish || (canWrite && d.status === 'draft' && d.created_by === user?.id);

  // Translating uses the AI and can take a while, so it asks first, shows a
  // spinner on the chip, and opens the new draft when it is done.
  const canTranslate = (d: KnowledgeDocSummary) =>
    !d.translation_of && canTranslateArticle({ isAdmin: canPublish, userId: user?.id ?? null, article: d });

  async function translateInto(d: KnowledgeDocSummary, language: KbLanguage) {
    if (!window.confirm(tt('translateConfirm', { language: KB_LANGUAGE_LABELS[language], title: d.title }))) return;
    setTranslatingKey(`${d.id}:${language}`);
    try {
      const outcomes = await translate(d.id, [language], false);
      const id = createdArticleId(outcomes);
      if (id) router.push(`/knowledge/${id}`);
      else await load();
    } finally {
      setTranslatingKey(null);
    }
  }

  async function remove(d: KnowledgeDocSummary) {
    // Deleting an article deletes its translations too: say so first.
    const message =
      d.translations.length > 0
        ? tt('deleteWithTranslations', { title: d.title, count: d.translations.length })
        : t('deleteConfirm', { title: d.title });
    if (!window.confirm(message)) return;
    setBusyId(d.id);
    try {
      const res = await fetch(`/api/knowledge/${d.id}${d.translations.length > 0 ? '?with_translations=true' : ''}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('deleteFailed'));
        return;
      }
      setDocs((prev) => prev.filter((x) => x.id !== d.id && x.translation_of !== d.id));
      toast.success(t('deleted'));
    } catch {
      toast.error(t('deleteFailed'));
    } finally {
      setBusyId(null);
    }
  }

  async function publish(d: KnowledgeDocSummary) {
    setBusyId(d.id);
    try {
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
      await load();
    } catch {
      toast.error(t('publishFailed'));
    } finally {
      setBusyId(null);
    }
  }

  async function resync(d: KnowledgeDocSummary) {
    setBusyId(d.id);
    try {
      const res = await fetch(`/api/knowledge/${d.id}/resync`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? tl('resyncFailed'));
        return;
      }
      toast.success(tl('resynced'));
      await load();
    } catch {
      toast.error(tl('resyncFailed'));
    } finally {
      setBusyId(null);
    }
  }

  // The list rows do not carry the source address, so it is fetched on
  // demand. The tab is opened first, inside the click, or the pop-up
  // blocker would stop a window opened after the request.
  async function openSource(d: KnowledgeDocSummary) {
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    try {
      const res = await fetch(`/api/knowledge/${d.id}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      const url = typeof data.source_url === 'string' ? data.source_url : '';
      if (!res.ok || !/^https?:\/\//i.test(url)) throw new Error('no source');
      if (tab) tab.location.href = url;
      else window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      tab?.close();
      toast.error(tl('sourceFailed'));
    }
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

  const listView = isListView(view);

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 overflow-y-auto p-4 md:p-6">
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
          {canManageKb && docs.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => void reindex()} disabled={reindexing} title={t('reindexHint')}>
              {reindexing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
              {t('reindex')}
            </Button>
          )}
          {canWrite && <AddContentMenu collections={collections} onImported={() => void load()} />}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      ) : loadFailed && docs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <p className="text-sm text-muted-foreground">{t('loadFailed')}</p>
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            {tl('retry')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4 md:flex-row md:gap-6">
          <LibraryRail
            view={view}
            onView={setView}
            counts={counts}
            collections={collections}
            openGaps={openGaps}
            canManageCollections={canManageKb}
            onManageCollections={() => setManaging(true)}
          />

          <div className="min-w-0 flex-1 space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile label={tl('stats.articles')} value={counts.all} />
              <StatTile label={tl('stats.published')} value={counts.published} />
              <StatTile label={tl('stats.aiAnswers', { days: windowDays })} value={aiAnswers} />
              <StatTile
                label={tl('stats.unanswered')}
                value={openGaps}
                urgent={openGaps > 0}
                onClick={() => setView('gaps')}
              />
            </div>

            {view === 'gaps' ? (
              <KnowledgeGaps canWrite={canWrite} onCount={setOpenGaps} />
            ) : view === 'insights' ? (
              <InsightsView />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={tl('searchPlaceholder')}
                    className="h-9 min-w-0 max-w-xs flex-1"
                    aria-label={tl('searchPlaceholder')}
                  />
                  <select
                    className={cn(selectClass, 'w-auto')}
                    value={lang}
                    onChange={(e) => setLang(e.target.value)}
                    aria-label={t('filterLanguage')}
                  >
                    <option value="">{t('allLanguages')}</option>
                    {KB_LANGUAGES.map((l) => (
                      <option key={l} value={l}>
                        {KB_LANGUAGE_LABELS[l]}
                      </option>
                    ))}
                  </select>
                  {canPublish && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch checked={showTranslations} onCheckedChange={setShowTranslations} aria-label={tt('showAsRows')} />
                      {tt('showAsRows')}
                    </label>
                  )}
                </div>

                {docs.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border p-10 text-center">
                    <BookOpen className="mx-auto h-8 w-8 text-muted-foreground" />
                    <p className="mt-3 text-sm font-medium text-foreground">{t('emptyTitle')}</p>
                    <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t('emptyBody')}</p>
                    {canWrite && (
                      <div className="mt-4 flex justify-center">
                        <AddContentMenu collections={collections} onImported={() => void load()} />
                      </div>
                    )}
                  </div>
                ) : shown.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">{tl('noMatches')}</p>
                ) : (
                  listView && (
                    <ArticleTable
                      docs={shown}
                      collections={collections}
                      today={today}
                      canPublish={canPublish}
                      canManage={canManage}
                      busyId={busyId}
                      onPublish={(d) => void publish(d)}
                      onDelete={(d) => void remove(d)}
                      onResync={(d) => void resync(d)}
                      onOpenSource={(d) => void openSource(d)}
                      canTranslate={canTranslate}
                      translatingKey={translatingKey}
                      onTranslate={(d, language) => void translateInto(d, language)}
                      titleOf={(id) => titleById.get(id)}
                    />
                  )
                )}
              </>
            )}
          </div>
        </div>
      )}

      {managing && (
        <CollectionsDialog
          open
          onOpenChange={(o) => {
            if (!o) setManaging(false);
          }}
          collections={collections}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}
