'use client';

// TeamFormDialog — create or edit a team (name, description, colour).
// Needs teams.manage; the API route checks it again.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  TEAM_DESCRIPTION_MAX_LEN,
  TEAM_NAME_MAX_LEN,
} from '@/lib/teams/validation';
import { cn } from '@/lib/utils';
import type { Team } from '@/types';

export const TEAM_PRESET_COLORS = [
  { name: 'red', value: '#ef4444' },
  { name: 'orange', value: '#f97316' },
  { name: 'amber', value: '#f59e0b' },
  { name: 'emerald', value: '#10b981' },
  { name: 'cyan', value: '#06b6d4' },
  { name: 'blue', value: '#3b82f6' },
  { name: 'violet', value: '#8b5cf6' },
  { name: 'pink', value: '#ec4899' },
] as const;

interface FormValues {
  name: string;
  description: string;
  color: string;
}

const BLANK: FormValues = {
  name: '',
  description: '',
  color: TEAM_PRESET_COLORS[5].value,
};

export function TeamFormDialog({
  open,
  onOpenChange,
  team,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create. */
  team: Team | null;
  onSaved: () => void | Promise<void>;
}) {
  const t = useTranslations('Settings.team.teams');
  const tColors = useTranslations('Settings.tagsAndFields');
  const isEdit = team !== null;
  const [values, setValues] = useState<FormValues>(BLANK);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues(
      team
        ? {
            name: team.name,
            description: team.description ?? '',
            color: team.color,
          }
        : BLANK,
    );
  }, [open, team]);

  async function handleSubmit() {
    const name = values.name.trim();
    if (!name) {
      toast.error(t('nameRequired'));
      return;
    }
    setSaving(true);
    try {
      const url = isEdit ? `/api/account/teams/${team!.id}` : '/api/account/teams';
      const res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description: values.description.trim(),
          color: values.color,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(
          payload.error || (isEdit ? t('updateFailed') : t('createFailed')),
        );
        return;
      }
      toast.success(isEdit ? t('teamUpdated') : t('teamCreated'));
      onOpenChange(false);
      await onSaved();
    } catch (err) {
      console.error('[TeamFormDialog] save error:', err);
      toast.error(t('networkError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {isEdit ? t('edit') : t('createTeam')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('nameLabel')}
            </label>
            <Input
              value={values.name}
              onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
              placeholder={t('namePlaceholder')}
              maxLength={TEAM_NAME_MAX_LEN}
              className="bg-muted text-foreground"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('descriptionLabel')}
            </label>
            <Textarea
              value={values.description}
              onChange={(e) =>
                setValues((v) => ({ ...v, description: e.target.value }))
              }
              placeholder={t('descriptionPlaceholder')}
              maxLength={TEAM_DESCRIPTION_MAX_LEN}
              className="bg-muted text-foreground"
              rows={2}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('colorLabel')}
            </label>
            <div className="flex gap-1.5">
              {TEAM_PRESET_COLORS.map((color) => {
                const colorName = tColors(
                  `colors.${color.name}` as Parameters<typeof tColors>[0],
                );
                return (
                  <button
                    key={color.value}
                    type="button"
                    onClick={() => setValues((v) => ({ ...v, color: color.value }))}
                    aria-label={tColors('useColor', { color: colorName })}
                    aria-pressed={values.color === color.value}
                    className={cn(
                      'size-6 rounded-md transition-transform hover:scale-110',
                      values.color === color.value &&
                        'outline outline-2 outline-offset-2 outline-primary',
                    )}
                    style={{ backgroundColor: color.value }}
                    title={colorName}
                  />
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter className="border-border bg-popover">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {isEdit ? t('saving') : t('creating')}
              </>
            ) : isEdit ? (
              t('save')
            ) : (
              t('create')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
