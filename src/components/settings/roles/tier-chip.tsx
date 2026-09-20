'use client';

import { useTranslations } from 'next-intl';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { EnforcedBy } from '@/lib/auth/capabilities';
import { SettingsChip } from '../settings-chip';

/**
 * "Database + App" or "App": where a capability is enforced. The
 * tooltip states the difference honestly (see Permissions.tier.*).
 */
export function TierChip({ enforcedBy }: { enforcedBy: EnforcedBy }) {
  const t = useTranslations('Permissions.tier');
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
        }
      >
        <SettingsChip variant={enforcedBy === 'database' ? 'ok' : 'muted'}>
          {t(enforcedBy)}
        </SettingsChip>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 whitespace-normal">
        {t(`${enforcedBy}Tooltip`)}
      </TooltipContent>
    </Tooltip>
  );
}

/** Small always-visible legend explaining both tiers (works on touch). */
export function TierLegend() {
  const t = useTranslations('Permissions.tier');
  return (
    <dl className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground sm:grid-cols-2">
      <div className="space-y-1">
        <dt>
          <SettingsChip variant="ok">{t('database')}</SettingsChip>
        </dt>
        <dd>{t('databaseLegend')}</dd>
      </div>
      <div className="space-y-1">
        <dt>
          <SettingsChip variant="muted">{t('app')}</SettingsChip>
        </dt>
        <dd>{t('appLegend')}</dd>
      </div>
    </dl>
  );
}
