'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Download, Loader2, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { useCapability } from '@/hooks/use-can';
import { downloadCsv } from '@/lib/csv';
import { createClient } from '@/lib/supabase/client';
import { isContactTag, isConversationLabel } from '@/lib/tags/scope';
import { tagsToCsv, type TagKind } from '@/lib/tags/tag-csv';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Tag } from '@/types';

import { SettingsPanelHead } from '../settings-panel-head';
import { TagEditDialog } from './tag-edit-dialog';
import { TagImportDialog } from './tag-import-dialog';

interface Usage {
  contacts: number;
  conversations: number;
}

/**
 * Settings table for one of the two lists that share the `tags` palette
 * (migration 068): contact **tags** or **conversation labels**. Anyone
 * can read it; admins can create / edit / delete and bulk import /
 * export via CSV.
 */
export function TagCatalogPanel({
  kind,
  onChanged,
}: {
  kind: TagKind;
  /** Called after a create / edit / delete / import, so siblings that read the palette can refresh. */
  onChanged?: () => void;
}) {
  const t = useTranslations('Settings.tagCatalog');
  const { accountId, loading: authLoading } = useAuth();
  const canEdit = useCapability('tags.manage');

  const [loading, setLoading] = useState(true);
  const [tags, setTags] = useState<Tag[]>([]);
  const [usage, setUsage] = useState<Map<string, Usage>>(new Map());
  const [creators, setCreators] = useState<Map<string, string>>(new Map());
  const [search, setSearch] = useState('');

  // Dialogs are keyed by a counter so each open mounts fresh state.
  const [editing, setEditing] = useState<{ tag: Tag | null; key: number } | null>(null);
  const [importKey, setImportKey] = useState<number | null>(null);
  const [toDelete, setToDelete] = useState<Tag | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [tagsRes, usageRes, profilesRes] = await Promise.all([
      supabase.from('tags').select('*').order('name'),
      supabase.from('tag_usage_counts').select('tag_id, contact_count, conversation_count'),
      supabase.from('profiles').select('user_id, full_name, email'),
    ]);
    if (tagsRes.error) {
      console.error('[TagCatalogPanel] load failed:', tagsRes.error);
      toast.error(t('loadFailed'));
    }
    setTags((tagsRes.data as Tag[]) ?? []);
    setUsage(
      new Map(
        (usageRes.data ?? []).map((u) => [
          u.tag_id as string,
          { contacts: u.contact_count as number, conversations: u.conversation_count as number },
        ]),
      ),
    );
    setCreators(
      new Map(
        (profilesRes.data ?? []).map((p) => [
          p.user_id as string,
          ((p.full_name as string | null) || (p.email as string | null) || '').trim(),
        ]),
      ),
    );
    setLoading(false);
  }, [t]);

  useEffect(() => {
    if (authLoading || !accountId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [authLoading, accountId, load]);

  const reload = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  const inList = kind === 'tag' ? isContactTag : isConversationLabel;
  const listTags = useMemo(() => tags.filter(inList), [tags, inList]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return listTags;
    return listTags.filter(
      (tag) =>
        tag.name.toLowerCase().includes(q) || (tag.description ?? '').toLowerCase().includes(q),
    );
  }, [listTags, search]);

  const takenNamesFor = (self: Tag | null) =>
    new Set(tags.filter((tag) => tag.id !== self?.id).map((tag) => tag.name.trim().toLowerCase()));

  function handleExport() {
    const date = format(new Date(), 'yyyy-MM-dd');
    downloadCsv(`${t(`${kind}.fileName`)}-${date}.csv`, tagsToCsv(listTags));
  }

  async function handleDelete() {
    if (!toDelete) return;
    setDeleting(true);
    const { error } = await createClient().from('tags').delete().eq('id', toDelete.id);
    setDeleting(false);
    if (error) {
      console.error('[TagCatalogPanel] delete failed:', error);
      toast.error(t('deleteFailed'));
      return;
    }
    toast.success(t(`${kind}.deleted`));
    setToDelete(null);
    await reload();
  }

  const usageCount = (tag: Tag) => {
    const u = usage.get(tag.id);
    return kind === 'tag' ? (u?.contacts ?? 0) : (u?.conversations ?? 0);
  };

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead title={t(`${kind}.title`)} description={t(`${kind}.description`)} />

      <div className="flex flex-wrap items-center gap-2">
        {canEdit ? (
          <Button size="sm" onClick={() => setEditing({ tag: null, key: Date.now() })}>
            <Plus className="size-4" />
            {t(`${kind}.createButton`)}
          </Button>
        ) : null}
        <div className="relative min-w-[200px] max-w-xs flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t(`${kind}.searchPlaceholder`)}
            className="h-9 pl-8"
            aria-label={t(`${kind}.searchPlaceholder`)}
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={listTags.length === 0}
          >
            <Download className="size-4" />
            {t('exportCsv')}
          </Button>
          {canEdit ? (
            <Button variant="outline" size="sm" onClick={() => setImportKey(Date.now())}>
              <Upload className="size-4" />
              {t('importCsv')}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : visible.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {search.trim() ? t('noMatches') : t(`${kind}.empty`)}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.name')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('columns.description')}</TableHead>
                <TableHead>{t('columns.inUse')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('columns.createdBy')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('columns.createdOn')}</TableHead>
                {canEdit ? <TableHead className="w-20 text-right">{t('columns.actions')}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((tag) => (
                <TableRow key={tag.id}>
                  <TableCell>
                    <span
                      className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
                      style={{
                        backgroundColor: `${tag.color}20`,
                        color: tag.color,
                        border: `1px solid ${tag.color}40`,
                      }}
                    >
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className="truncate">{tag.name}</span>
                    </span>
                  </TableCell>
                  <TableCell className="hidden max-w-xs truncate text-muted-foreground md:table-cell">
                    {tag.description || '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {t(`${kind}.inUse`, { count: usageCount(tag) })}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    {creators.get(tag.user_id) || '—'}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    {format(new Date(tag.created_at), 'MMM d, yyyy')}
                  </TableCell>
                  {canEdit ? (
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('editAria', { name: tag.name })}
                        onClick={() => setEditing({ tag, key: Date.now() })}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('deleteAria', { name: tag.name })}
                        onClick={() => setToDelete(tag)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {!canEdit ? <p className="text-xs text-muted-foreground">{t('adminOnlyHint')}</p> : null}

      {editing ? (
        <TagEditDialog
          key={editing.key}
          open
          onOpenChange={(o) => {
            if (!o) setEditing(null);
          }}
          kind={kind}
          tag={editing.tag}
          takenNames={takenNamesFor(editing.tag)}
          onSaved={reload}
        />
      ) : null}

      {importKey !== null ? (
        <TagImportDialog
          key={importKey}
          open
          onOpenChange={(o) => {
            if (!o) setImportKey(null);
          }}
          kind={kind}
          existing={tags}
          onDone={reload}
        />
      ) : null}

      <Dialog open={toDelete !== null} onOpenChange={(o) => (!o && !deleting ? setToDelete(null) : undefined)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t(`${kind}.deleteTitle`)}</DialogTitle>
            <DialogDescription>
              {toDelete
                ? t('deleteConfirm', {
                    name: toDelete.name,
                    contacts: usage.get(toDelete.id)?.contacts ?? 0,
                    conversations: usage.get(toDelete.id)?.conversations ?? 0,
                  })
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setToDelete(null)} disabled={deleting}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
              {t(`${kind}.deleteTitle`)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
