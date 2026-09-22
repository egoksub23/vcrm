'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, FileUp, Globe, ListChecks, MessageCircleQuestion, PenLine, Plus, type LucideIcon } from 'lucide-react';

import type { KnowledgeCollection } from '@/lib/knowledge-types';
import { Button } from '@/components/ui/button';
import { readOnlyTitle } from '@/components/ui/gated-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { FileImportDialog } from './file-import-dialog';
import { QaImportDialog } from './qa-import-dialog';
import { UrlImportDialog } from './url-import-dialog';

/** Bulk import lands as drafts via a dialog; 'article'/'qaSingle' write one
 *  entry directly in the editor (kind pre-selected, still switchable there). */
type ImportKind = 'qa' | 'file' | 'url';
type WriteKind = 'article' | 'qaSingle';

/** The "+ Add content" button: write one article or one Q&A directly, or
 *  bring content in in bulk. Every import lands as drafts. */
export function AddContentMenu({
  collections,
  onImported,
  disabled = false,
}: {
  collections: KnowledgeCollection[];
  onImported: () => void;
  /** knowledge.draft missing: the button stays but is disabled. */
  disabled?: boolean;
}) {
  const t = useTranslations('Knowledge.addContent');
  const router = useRouter();
  const [dialog, setDialog] = useState<ImportKind | null>(null);

  const writeItems: { id: WriteKind; icon: LucideIcon; label: string; hint: string }[] = [
    { id: 'article', icon: PenLine, label: t('article.menu'), hint: t('article.hint') },
    { id: 'qaSingle', icon: MessageCircleQuestion, label: t('qaSingle.menu'), hint: t('qaSingle.hint') },
  ];
  const importItems: { id: ImportKind; icon: LucideIcon; label: string; hint: string }[] = [
    { id: 'qa', icon: ListChecks, label: t('qa.menu'), hint: t('qa.hint') },
    { id: 'file', icon: FileUp, label: t('file.menu'), hint: t('file.hint') },
    { id: 'url', icon: Globe, label: t('url.menu'), hint: t('url.hint') },
  ];

  function pick(id: WriteKind | ImportKind) {
    if (id === 'article' || id === 'qaSingle') router.push(`/knowledge/new?kind=${id === 'qaSingle' ? 'qa' : 'article'}`);
    // Closing unmounts the dialog, so each open starts clean.
    else setDialog(id);
  }

  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button size="sm" disabled={disabled} title={disabled ? readOnlyTitle('add knowledge content') : undefined} />
          }
        >
          <Plus className="mr-1.5 h-4 w-4" /> {t('button')}
          <ChevronDown className="ml-1 h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-96 max-w-[calc(100vw-2rem)]">
          <DropdownMenuLabel>{t('writeGroupLabel')}</DropdownMenuLabel>
          {writeItems.map((it) => (
            <DropdownMenuItem key={it.id} onClick={() => pick(it.id)} className="items-start gap-2.5 py-2">
              <it.icon className="mt-0.5 h-4 w-4 text-primary" />
              <span className="grid gap-0.5">
                <span className="font-medium">{it.label}</span>
                <span className="text-xs text-muted-foreground">{it.hint}</span>
              </span>
            </DropdownMenuItem>
          ))}
          <p className="px-2 pt-0.5 pb-1.5 text-[11px] leading-snug text-muted-foreground">{t('writeGroupTip')}</p>

          <DropdownMenuSeparator />

          <DropdownMenuLabel>{t('importGroupLabel')}</DropdownMenuLabel>
          {importItems.map((it) => (
            <DropdownMenuItem key={it.id} onClick={() => pick(it.id)} className="items-start gap-2.5 py-2">
              <it.icon className="mt-0.5 h-4 w-4 text-primary" />
              <span className="grid gap-0.5">
                <span className="font-medium">{it.label}</span>
                <span className="text-xs text-muted-foreground">{it.hint}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === 'qa' && (
        <QaImportDialog open onOpenChange={close} collections={collections} onImported={onImported} />
      )}
      {dialog === 'file' && (
        <FileImportDialog open onOpenChange={close} collections={collections} onImported={onImported} />
      )}
      {dialog === 'url' && (
        <UrlImportDialog open onOpenChange={close} collections={collections} onImported={onImported} />
      )}
    </>
  );
}
