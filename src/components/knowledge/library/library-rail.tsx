'use client';

import { useTranslations } from 'next-intl';
import {
  BarChart3,
  BookOpen,
  FileEdit,
  HelpCircle,
  Lock,
  Settings2,
  Timer,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { readOnlyTitle } from '@/components/ui/gated-button';
import type { KnowledgeCollection } from '@/lib/knowledge-types';

import { collectionView, safeHexColor, type LibraryCounts, type LibraryView } from './library-helpers';
import { selectClass } from './import-shared';

interface RailProps {
  view: LibraryView;
  onView: (v: LibraryView) => void;
  counts: LibraryCounts;
  collections: KnowledgeCollection[];
  openGaps: number;
  /** knowledge.manage: may create, rename and delete collections. */
  canManageCollections: boolean;
  onManageCollections: () => void;
}

function RailButton({
  active,
  onClick,
  icon: Icon,
  dot,
  label,
  count,
  urgent,
}: {
  active: boolean;
  onClick: () => void;
  icon?: LucideIcon;
  dot?: string;
  label: string;
  count?: string | number;
  urgent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
        active ? 'bg-primary/15 font-medium text-primary' : 'text-foreground hover:bg-muted',
      )}
    >
      {dot ? (
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: dot }} />
      ) : Icon ? (
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span
          className={cn(
            'shrink-0 text-xs tabular-nums',
            urgent ? 'rounded-full bg-destructive/15 px-1.5 py-0.5 font-medium text-destructive' : 'text-muted-foreground',
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/** The library's left rail: all articles, collections, and the views. On
 *  phones it folds into a single dropdown. */
export function LibraryRail({ view, onView, counts, collections, openGaps, canManageCollections, onManageCollections }: RailProps) {
  const t = useTranslations('Knowledge.library');

  return (
    <>
      {/* Phone: one dropdown, plus a manage button for admins. */}
      <div className="flex items-center gap-2 md:hidden">
        <select
          className={selectClass}
          value={view}
          onChange={(e) => onView(e.target.value as LibraryView)}
          aria-label={t('rail.view')}
        >
          <option value="all">{t('rail.all')} ({counts.all})</option>
          <optgroup label={t('rail.collections')}>
            {collections.map((c) => (
              <option key={c.id} value={collectionView(c.id)}>
                {c.name} ({counts.byCollection[c.id] ?? 0})
              </option>
            ))}
          </optgroup>
          <optgroup label={t('rail.views')}>
            <option value="drafts">{t('rail.drafts')} ({counts.drafts})</option>
            <option value="review">{t('rail.review')} ({counts.review})</option>
            <option value="agents">{t('rail.agents')} ({counts.agents})</option>
            <option value="gaps">{t('rail.gaps')} ({openGaps})</option>
            <option value="insights">{t('rail.insights')}</option>
          </optgroup>
        </select>
        <button
          type="button"
          onClick={onManageCollections}
          disabled={!canManageCollections}
          className="shrink-0 rounded-md border border-border p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t('rail.manage')}
          title={canManageCollections ? t('rail.manage') : readOnlyTitle('manage collections')}
        >
          <Settings2 className="h-4 w-4" />
        </button>
      </div>

      {/* Tablet and up: the rail. */}
      <nav className="hidden w-52 shrink-0 md:block lg:w-56" aria-label={t('rail.view')}>
        <div className="grid gap-0.5">
          <RailButton
            active={view === 'all'}
            onClick={() => onView('all')}
            icon={BookOpen}
            label={t('rail.all')}
            count={counts.all}
          />
        </div>

        <div className="mt-4 flex items-center justify-between px-2.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('rail.collections')}
          </h2>
          <button
            type="button"
            onClick={onManageCollections}
            disabled={!canManageCollections}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t('rail.manage')}
            title={canManageCollections ? t('rail.manage') : readOnlyTitle('manage collections')}
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-1 grid gap-0.5">
          {collections.length === 0 ? (
            <p className="px-2.5 py-1 text-xs text-muted-foreground">{t('rail.noCollections')}</p>
          ) : (
            collections.map((c) => (
              <RailButton
                key={c.id}
                active={view === collectionView(c.id)}
                onClick={() => onView(collectionView(c.id))}
                dot={safeHexColor(c.color)}
                label={c.name}
                count={counts.byCollection[c.id] ?? 0}
              />
            ))
          )}
        </div>

        <h2 className="mt-4 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('rail.views')}
        </h2>
        <div className="mt-1 grid gap-0.5">
          <RailButton active={view === 'drafts'} onClick={() => onView('drafts')} icon={FileEdit} label={t('rail.drafts')} count={counts.drafts} />
          <RailButton active={view === 'review'} onClick={() => onView('review')} icon={Timer} label={t('rail.review')} count={counts.review} />
          <RailButton active={view === 'agents'} onClick={() => onView('agents')} icon={Lock} label={t('rail.agents')} count={counts.agents} />
          <RailButton
            active={view === 'gaps'}
            onClick={() => onView('gaps')}
            icon={HelpCircle}
            label={t('rail.gaps')}
            count={openGaps > 0 ? t('rail.gapsOpen', { count: openGaps }) : 0}
            urgent={openGaps > 0}
          />
          <RailButton active={view === 'insights'} onClick={() => onView('insights')} icon={BarChart3} label={t('rail.insights')} />
        </div>
      </nav>
    </>
  );
}
