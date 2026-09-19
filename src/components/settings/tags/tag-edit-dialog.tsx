'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import {
  DEFAULT_TAG_COLOR,
  TAG_DESCRIPTION_MAX,
  TAG_NAME_MAX,
  type TagKind,
} from '@/lib/tags/tag-csv';
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
import type { Tag } from '@/types';

import { TagColorPicker } from './tag-color-picker';

const otherKind = (k: TagKind): TagKind => (k === 'tag' ? 'label' : 'tag');
const flagFor = (k: TagKind) => (k === 'tag' ? 'for_contacts' : 'for_conversations') as
  | 'for_contacts'
  | 'for_conversations';

/**
 * Create / edit one tag or conversation label. The parent remounts it
 * (via `key`) for each open, so initial state is read straight from
 * `tag` with no reset effect.
 */
export function TagEditDialog({
  open,
  onOpenChange,
  kind,
  tag,
  takenNames,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: TagKind;
  /** null = create. */
  tag: Tag | null;
  /** Lower-cased names already in use by OTHER entries. */
  takenNames: Set<string>;
  onSaved: () => void;
}) {
  const t = useTranslations('Settings.tagCatalog');
  const { user, accountId } = useAuth();

  const other = otherKind(kind);
  const [name, setName] = useState(tag?.name ?? '');
  const [description, setDescription] = useState(tag?.description ?? '');
  const [color, setColor] = useState((tag?.color ?? DEFAULT_TAG_COLOR).toLowerCase());
  const [alsoOther, setAlsoOther] = useState(tag ? tag[flagFor(other)] !== false : false);
  const [saving, setSaving] = useState(false);

  const trimmed = name.trim();
  const duplicate = trimmed !== '' && takenNames.has(trimmed.toLowerCase());
  const canSave = trimmed !== '' && !duplicate && !saving;

  async function handleSave() {
    if (!canSave || !user || !accountId) return;
    setSaving(true);
    const supabase = createClient();
    const fields = {
      name: trimmed,
      description: description.trim() || null,
      color,
      [flagFor(kind)]: true,
      [flagFor(other)]: alsoOther,
    };
    const { error } = tag
      ? await supabase.from('tags').update(fields).eq('id', tag.id)
      : await supabase
          .from('tags')
          .insert({ ...fields, user_id: user.id, account_id: accountId });
    setSaving(false);
    if (error) {
      console.error('[TagEditDialog] save failed:', error);
      toast.error(error.code === '23505' ? t('duplicateName') : t('saveFailed'));
      return;
    }
    toast.success(tag ? t(`${kind}.updated`) : t(`${kind}.created`));
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tag ? t(`${kind}.editTitle`) : t(`${kind}.createTitle`)}</DialogTitle>
          <DialogDescription>{t(`${kind}.dialogDescription`)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="tag-name">{t('columns.name')}</Label>
            <Input
              id="tag-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
              }}
              maxLength={TAG_NAME_MAX}
              placeholder={t(`${kind}.namePlaceholder`)}
              autoFocus
            />
            {duplicate ? (
              <p className="text-xs text-destructive">{t('duplicateName')}</p>
            ) : null}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="tag-description">{t('columns.description')}</Label>
            <Textarea
              id="tag-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={TAG_DESCRIPTION_MAX}
              rows={2}
              placeholder={t(`${kind}.descriptionPlaceholder`)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label>{t('colorLabel')}</Label>
            <TagColorPicker value={color} onChange={setColor} />
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              {t('preview')}
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
                style={{
                  backgroundColor: `${color}20`,
                  color,
                  border: `1px solid ${color}40`,
                }}
              >
                <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
                {trimmed || t(`${kind}.namePlaceholder`)}
              </span>
            </div>
          </div>

          <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
            <div className="min-w-0">
              <Label htmlFor="tag-also-other" className="text-sm">
                {t(`${kind}.alsoUseLabel`)}
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">{t(`${kind}.alsoUseHint`)}</p>
            </div>
            <Switch
              id="tag-also-other"
              checked={alsoOther}
              onCheckedChange={setAlsoOther}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
