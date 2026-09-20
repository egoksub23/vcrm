'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { FileText } from 'lucide-react';

import { KB_LANGUAGES, KB_LANGUAGE_LABELS, type KbLanguage } from '@/lib/ai/knowledge-query';
import type { KnowledgeCollection } from '@/lib/knowledge-types';

import type { ImportedDraft } from './library-helpers';

export const selectClass =
  'h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary/50';

/** Language and collection the imported drafts will get. */
export function ImportTargetFields({
  language,
  onLanguage,
  collectionId,
  onCollection,
  collections,
  disabled,
}: {
  language: KbLanguage;
  onLanguage: (l: KbLanguage) => void;
  collectionId: string;
  onCollection: (id: string) => void;
  collections: KnowledgeCollection[];
  disabled?: boolean;
}) {
  const t = useTranslations('Knowledge.addContent');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-xs font-medium text-muted-foreground">
        {t('language')}
        <select
          className={selectClass}
          value={language}
          onChange={(e) => onLanguage(e.target.value as KbLanguage)}
          disabled={disabled}
        >
          {KB_LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {KB_LANGUAGE_LABELS[l]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs font-medium text-muted-foreground">
        {t('collection')}
        <select
          className={selectClass}
          value={collectionId}
          onChange={(e) => onCollection(e.target.value)}
          disabled={disabled}
        >
          <option value="">{t('noCollection')}</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** What an import created: each draft links to its editor for review. */
export function ImportResults({ drafts, skipped }: { drafts: ImportedDraft[]; skipped?: number }) {
  const t = useTranslations('Knowledge.addContent');
  return (
    <div className="grid gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3">
      <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
        {t('created', { count: drafts.length })}
        {skipped ? ` · ${t('skipped', { count: skipped })}` : ''}
      </p>
      <ul className="max-h-40 space-y-1 overflow-y-auto">
        {drafts.map((d) => (
          <li key={d.id}>
            <Link
              href={`/knowledge/${d.id}`}
              className="flex items-center gap-1.5 text-sm text-foreground hover:underline"
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{d.title}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t('draftsNotice')}</p>
    </div>
  );
}
