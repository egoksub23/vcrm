'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { KnowledgeCollection } from '@/lib/knowledge-types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { DEFAULT_COLLECTION_COLOR, safeHexColor } from './library-helpers';

export const COLLECTION_COLORS = [
  DEFAULT_COLLECTION_COLOR,
  '#2563EB',
  '#0891B2',
  '#059669',
  '#CA8A04',
  '#EA580C',
  '#DC2626',
  '#DB2777',
] as const;

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true } : { ok: false, error: data.error };
  } catch {
    return { ok: false };
  }
}

function Swatches({ value, onPick, disabled }: { value: string; onPick: (c: string) => void; disabled?: boolean }) {
  const t = useTranslations('Knowledge.collections');
  return (
    <div className="flex flex-wrap gap-1">
      {COLLECTION_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          disabled={disabled}
          onClick={() => onPick(c)}
          aria-label={t('colour', { colour: c })}
          aria-pressed={value.toLowerCase() === c.toLowerCase()}
          className={cn(
            'h-5 w-5 rounded-full ring-offset-2 ring-offset-popover transition-shadow',
            value.toLowerCase() === c.toLowerCase() ? 'ring-2 ring-foreground/60' : 'hover:ring-2 hover:ring-foreground/20',
          )}
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  );
}

function CollectionRow({
  c,
  onChanged,
}: {
  c: KnowledgeCollection;
  onChanged: () => void;
}) {
  const t = useTranslations('Knowledge.collections');
  const [name, setName] = useState(c.name);
  const [busy, setBusy] = useState(false);

  async function patch(body: { name?: string; color?: string }) {
    setBusy(true);
    const r = await call(`/api/knowledge/collections/${c.id}`, 'PATCH', body);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error ?? t('saveFailed'));
      setName(c.name);
      return;
    }
    onChanged();
  }

  async function remove() {
    if (!window.confirm(t('deleteConfirm', { name: c.name }))) return;
    setBusy(true);
    const r = await call(`/api/knowledge/collections/${c.id}`, 'DELETE');
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error ?? t('deleteFailed'));
      return;
    }
    onChanged();
  }

  const commitName = () => {
    const next = name.trim();
    if (!next) setName(c.name);
    else if (next !== c.name) void patch({ name: next });
  };

  return (
    <li className="grid gap-2 rounded-lg border border-border p-2.5">
      <div className="flex items-center gap-2">
        <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: safeHexColor(c.color) }} />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          maxLength={60}
          disabled={busy}
          className="h-8"
          aria-label={t('nameLabel')}
        />
        <button
          type="button"
          onClick={() => void remove()}
          disabled={busy}
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
          aria-label={t('delete')}
          title={t('delete')}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <Swatches value={safeHexColor(c.color)} onPick={(color) => void patch({ color })} disabled={busy} />
    </li>
  );
}

/** Admins: add, rename, recolour and delete collections. Deleting one keeps
 *  its articles (they just lose the folder). */
export function CollectionsDialog({
  open,
  onOpenChange,
  collections,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collections: KnowledgeCollection[];
  onChanged: () => void;
}) {
  const t = useTranslations('Knowledge.collections');
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(DEFAULT_COLLECTION_COLOR);
  const [adding, setAdding] = useState(false);

  async function add() {
    const next = name.trim();
    if (!next || adding) return;
    setAdding(true);
    const r = await call('/api/knowledge/collections', 'POST', { name: next, color });
    setAdding(false);
    if (!r.ok) {
      toast.error(r.error ?? t('saveFailed'));
      return;
    }
    setName('');
    onChanged();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          {collections.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ul className="grid gap-2">
              {collections.map((c) => (
                <CollectionRow key={`${c.id}:${c.name}:${c.color}`} c={c} onChanged={onChanged} />
              ))}
            </ul>
          )}
        </div>

        <form
          className="grid gap-2 rounded-lg border border-dashed border-border p-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('newPlaceholder')}
              maxLength={60}
              className="h-8"
              aria-label={t('nameLabel')}
            />
            <Button type="submit" size="sm" disabled={adding || !name.trim()}>
              {adding ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
              {t('add')}
            </Button>
          </div>
          <Swatches value={color} onPick={setColor} />
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
