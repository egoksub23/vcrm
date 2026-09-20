'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { ExternalLink, FileText, Globe, Loader2, MoreHorizontal, Paperclip, Pencil, RefreshCw, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { KB_LANGUAGES, KB_LANGUAGE_LABELS, type KbLanguage } from '@/lib/ai/knowledge-query';
import type { KnowledgeCollection, KnowledgeDocSummary, KnowledgeTranslationInfo } from '@/lib/knowledge-types';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

import { docStatusOf, safeHexColor, translationMark, type TranslationMark } from './library-helpers';

const chip = 'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap';

export interface ArticleTableProps {
  docs: KnowledgeDocSummary[];
  collections: KnowledgeCollection[];
  today: string;
  /** knowledge.publish: may publish a draft. */
  canPublish: boolean;
  canManage: (d: KnowledgeDocSummary) => boolean;
  /** Id of the article a row action is running for. */
  busyId: string | null;
  onPublish: (d: KnowledgeDocSummary) => void;
  onDelete: (d: KnowledgeDocSummary) => void;
  onResync: (d: KnowledgeDocSummary) => void;
  onOpenSource: (d: KnowledgeDocSummary) => void;
  /** May this person translate this (base) article? */
  canTranslate: (d: KnowledgeDocSummary) => boolean;
  /** `${articleId}:${language}` of the translation running now. */
  translatingKey: string | null;
  onTranslate: (d: KnowledgeDocSummary, language: KbLanguage) => void;
  /** Title of any article by id, for "Translation of ..." on a translation row. */
  titleOf: (id: string) => string | undefined;
}

const DOT: Record<TranslationMark, string> = {
  outOfDate: 'bg-amber-500',
  machine: 'bg-primary',
  draft: 'bg-muted-foreground/60',
  ok: 'bg-emerald-500',
};

/** Chips for the other languages of a base article: filled when a translation
 *  exists (a dot shows what needs attention), an outline "+ Translate" when
 *  not. */
function TranslationChips({
  d,
  canTranslate,
  translatingKey,
  onTranslate,
  disabled,
}: {
  d: KnowledgeDocSummary;
  canTranslate: boolean;
  translatingKey: string | null;
  onTranslate: (d: KnowledgeDocSummary, language: KbLanguage) => void;
  disabled: boolean;
}) {
  const tt = useTranslations('Knowledge.translations');
  const byLanguage = new Map<KbLanguage, KnowledgeTranslationInfo>(d.translations.map((x) => [x.language, x]));
  const base = 'inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-medium whitespace-nowrap';

  return (
    <div className="flex flex-wrap items-center gap-1">
      {KB_LANGUAGES.filter((l) => l !== d.language).map((language) => {
        const info = byLanguage.get(language);
        const label = KB_LANGUAGE_LABELS[language];
        if (info) {
          const mark = translationMark(info);
          const parts = [
            info.status === 'published' ? tt('statusPublished') : tt('statusDraft'),
            info.machine_translated ? tt('machine') : tt('edited'),
            ...(info.out_of_date ? [tt('outOfDate')] : []),
          ];
          return (
            <Link
              key={language}
              href={`/knowledge/${info.id}`}
              className={cn(base, 'bg-muted text-foreground hover:bg-muted/70')}
              title={tt('chipTitle', { language: label, state: parts.join(', ') })}
              aria-label={tt('openTranslation', { language: label })}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', DOT[mark])} aria-hidden />
              {language.toUpperCase()}
            </Link>
          );
        }
        const running = translatingKey === `${d.id}:${language}`;
        if (!canTranslate) {
          return (
            <span
              key={language}
              className={cn(base, 'border border-dashed border-border text-muted-foreground/60')}
              title={tt('notTranslatedIn', { language: label })}
            >
              {language.toUpperCase()}
            </span>
          );
        }
        return (
          <button
            key={language}
            type="button"
            onClick={() => onTranslate(d, language)}
            disabled={disabled}
            className={cn(base, 'border border-dashed border-border text-muted-foreground hover:border-primary/50 hover:text-primary disabled:cursor-not-allowed disabled:opacity-60')}
            title={tt('addLanguage', { language: label })}
            aria-label={tt('addLanguage', { language: label })}
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <span aria-hidden>+</span>}
            {language.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}

export function ArticleTable({
  docs,
  collections,
  today,
  canPublish,
  canManage,
  busyId,
  onPublish,
  onDelete,
  onResync,
  onOpenSource,
  canTranslate,
  translatingKey,
  onTranslate,
  titleOf,
}: ArticleTableProps) {
  const t = useTranslations('Knowledge');
  const tl = useTranslations('Knowledge.library');
  const tt = useTranslations('Knowledge.translations');
  const byId = new Map(collections.map((c) => [c.id, c]));

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="bg-muted text-left text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">{t('colTitle')}</th>
            <th className="px-3 py-2 font-medium">{tl('colCollection')}</th>
            <th className="px-3 py-2 font-medium">{tt('colTranslations')}</th>
            <th className="px-3 py-2 font-medium">{t('colAudience')}</th>
            <th className="px-3 py-2 font-medium">{t('colStatus')}</th>
            <th className="px-3 py-2 text-right font-medium" title={t('colAiUsesHint')}>
              {t('colAiUses')}
            </th>
            <th className="w-28 px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {docs.map((d) => {
            const status = docStatusOf(d, today);
            const collection = d.collection_id ? byId.get(d.collection_id) : undefined;
            const collectionName = collection?.name ?? d.category;
            const busy = busyId === d.id;
            return (
              <tr key={d.id} className="align-top hover:bg-muted/40">
                <td className="max-w-[340px] px-3 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <Link
                      href={`/knowledge/${d.id}`}
                      className="min-w-0 truncate font-medium text-foreground hover:underline"
                    >
                      {d.title}
                    </Link>
                    <span
                      className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                      title={KB_LANGUAGE_LABELS[d.language]}
                    >
                      {d.language.toUpperCase()}
                    </span>
                    {d.attachment_count > 0 && (
                      <span
                        className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
                        title={tl('attachments', { count: d.attachment_count })}
                        aria-label={tl('attachments', { count: d.attachment_count })}
                      >
                        <Paperclip className="h-3 w-3" />
                        {d.attachment_count}
                      </span>
                    )}
                  </div>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
                    {d.source_kind === 'url' ? (
                      <>
                        <Globe className="h-3 w-3" /> {tl('sourceUrl')}
                      </>
                    ) : d.source_kind === 'file' ? (
                      <>
                        <FileText className="h-3 w-3" /> {tl('sourceFile')}
                      </>
                    ) : d.kind === 'qa' ? (
                      t('kindQa')
                    ) : (
                      t('kindArticle')
                    )}
                    <span aria-hidden>·</span>
                    {tl('updated', { when: formatDistanceToNow(new Date(d.updated_at), { addSuffix: true }) })}
                    {status === 'review' && d.review_by ? (
                      <>
                        <span aria-hidden>·</span>
                        {tl('reviewSince', { date: d.review_by })}
                      </>
                    ) : null}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  {collectionName ? (
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: safeHexColor(collection?.color) }}
                      />
                      {collectionName}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">–</span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  {d.translation_of ? (
                    <Link
                      href={`/knowledge/${d.translation_of}`}
                      className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {tt('translationOf', { title: titleOf(d.translation_of) ?? '…' })}
                    </Link>
                  ) : (
                    <TranslationChips
                      d={d}
                      canTranslate={canTranslate(d)}
                      translatingKey={translatingKey}
                      onTranslate={onTranslate}
                      disabled={translatingKey !== null}
                    />
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <span className={cn(chip, d.use_in_ai ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
                    {d.use_in_ai ? t('audienceAi') : t('audienceAgents')}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <span
                    className={cn(
                      chip,
                      status === 'published'
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                        : 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
                    )}
                  >
                    {status === 'draft' ? t('statusDraft') : status === 'review' ? t('reviewDue') : t('statusPublished')}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                  {d.use_in_ai && d.status === 'published' ? d.ai_uses : '–'}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center justify-end gap-1">
                    {canPublish && d.status === 'draft' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => onPublish(d)}
                        disabled={busy}
                      >
                        {t('publish')}
                      </Button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-sm" />}
                        aria-label={tl('more')}
                        title={tl('more')}
                        disabled={busy}
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem render={<Link href={`/knowledge/${d.id}`} />}>
                          <Pencil /> {tl('open')}
                        </DropdownMenuItem>
                        {d.source_kind === 'url' && (
                          <>
                            <DropdownMenuItem onClick={() => onOpenSource(d)}>
                              <ExternalLink /> {tl('openSource')}
                            </DropdownMenuItem>
                            {canManage(d) && (
                              <DropdownMenuItem onClick={() => onResync(d)}>
                                <RefreshCw /> {tl('resync')}
                              </DropdownMenuItem>
                            )}
                          </>
                        )}
                        {canManage(d) && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onClick={() => onDelete(d)}>
                              <Trash2 /> {t('delete')}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
