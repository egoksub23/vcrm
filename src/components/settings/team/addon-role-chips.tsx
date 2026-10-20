'use client';

// ============================================================
// AddonRoleChips — the add-on roles (migration 191) a person holds, as small chips beside their base role. Up to `limit` show; the rest are "+N" with the
// names in the tooltip. They only ADD to the base role, so they read as an extra, never as a replacement.
// ============================================================

import { Layers } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import type { AddonRoleRef } from '@/lib/auth/addon-roles';

export const ADDON_CHIP_LIMIT = 2;

export function AddonRoleChips({
  addons,
  limit = 50,
  hideEmpty = false,
  className,
}: {
  addons: readonly AddonRoleRef[];
  /** How many chips show before the "+N". */
  limit?: number;
  /** Draw nothing when there are none (a list row), rather than the words "No add-on roles" (the member panel). */
  hideEmpty?: boolean;
  className?: string;
}) {
  const t = useTranslations('Settings.team.chips');
  if (addons.length === 0) {
    return hideEmpty ? null : <span className="text-xs text-muted-foreground">{t('noAddOns')}</span>;
  }
  const visible = addons.slice(0, Math.max(0, limit));
  const rest = addons.slice(visible.length);
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)} data-testid="addon-role-chips">
      {visible.map((a) => (
        <span
          key={a.id}
          className="inline-flex max-w-[10rem] items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs text-foreground"
          title={a.name}
        >
          <Layers className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{a.name}</span>
        </span>
      ))}
      {rest.length > 0 ? (
        <span
          className="inline-flex items-center rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
          title={rest.map((a) => a.name).join(', ')}
        >
          {t('addOnsMore', { count: rest.length })}
        </span>
      ) : null}
    </div>
  );
}
