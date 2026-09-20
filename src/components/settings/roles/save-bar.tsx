'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

interface SaveBarProps {
  count: number;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

/**
 * Pinned to the bottom of the panel while the selected role has unsaved
 * changes. Several switches apply together through one confirmation.
 */
export function SaveBar({ count, saving, onSave, onDiscard }: SaveBarProps) {
  const t = useTranslations('Permissions');
  if (count === 0) return null;
  return (
    <div
      role="region"
      aria-label={t('screen.saveBarLabel')}
      className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/95 px-4 py-3 shadow-lg backdrop-blur pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <p className="text-sm font-medium text-foreground" aria-live="polite">
        {t('screen.changeCount', { count })}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onDiscard} disabled={saving}>
          {t('screen.discard')}
        </Button>
        <Button onClick={onSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {t('screen.save')}
        </Button>
      </div>
    </div>
  );
}
