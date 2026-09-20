'use client';

import { Lock } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { capabilityI18nId, type CapabilityDef } from '@/lib/auth/capabilities';
import type { AccountRole } from '@/lib/auth/roles';
import { cn } from '@/lib/utils';
import { SettingsChip } from '../settings-chip';
import type { RowBlockReason } from './helpers';
import { TierChip } from './tier-chip';

export interface StoredChange {
  by: { id: string; name: string } | null;
  at: string;
}

interface CapabilityRowProps {
  cap: CapabilityDef;
  /** The role being edited (used in the reason text). */
  targetRole: AccountRole;
  /** Draft value of the switch. */
  on: boolean;
  /** Draft value differs from the role's built-in default. */
  changedFromDefault: boolean;
  /** Draft value differs from the saved state (not saved yet). */
  unsaved: boolean;
  /** Why the switch cannot be flipped, or null. */
  reason: RowBlockReason | null;
  /** Who last changed the stored override, when one exists. */
  stored?: StoredChange;
  onToggle: (next: boolean) => void;
}

/** Reasons that apply to the whole role are explained once in a banner. */
const ROLE_LEVEL: readonly RowBlockReason[] = [
  'owner-locked',
  'role-not-editable',
];

export function CapabilityRow({
  cap,
  targetRole,
  on,
  changedFromDefault,
  unsaved,
  reason,
  stored,
  onToggle,
}: CapabilityRowProps) {
  const t = useTranslations('Permissions');
  const tRoles = useTranslations('Settings.roles');
  const format = useFormatter();
  const id = capabilityI18nId(cap.key);
  const labelId = `cap-label-${id}`;
  const descId = `cap-desc-${id}`;
  const reasonId = `cap-reason-${id}`;
  const capLevelReason = reason !== null && !ROLE_LEVEL.includes(reason);
  const reasonText = reason
    ? t(`screen.reason.${reason}`, {
        role: tRoles(targetRole),
        min: tRoles(cap.minGrantRole),
      })
    : null;

  const describedBy = [descId, capLevelReason ? reasonId : null]
    .filter(Boolean)
    .join(' ');

  const sw = (
    <Switch
      checked={on}
      disabled={reason !== null}
      onCheckedChange={(next) => onToggle(next)}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
    />
  );

  const changedAt = stored
    ? format.dateTime(new Date(stored.at), {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '';

  return (
    <li
      className={cn(
        'flex items-start gap-3 px-4 py-3',
        unsaved && 'bg-primary-soft/40',
      )}
    >
      <div className="pt-0.5">
        {reasonText ? (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              {sw}
            </TooltipTrigger>
            <TooltipContent className="max-w-64 whitespace-normal">
              {reasonText}
            </TooltipContent>
          </Tooltip>
        ) : (
          sw
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span id={labelId} className="text-sm font-medium text-foreground">
            {t(`cap.${id}.label`)}
          </span>
          {changedFromDefault ? (
            <SettingsChip variant="admin" className="px-2 py-0 text-[11px]">
              {t('screen.changed')}
            </SettingsChip>
          ) : null}
          {unsaved ? (
            <SettingsChip variant="warn" className="px-2 py-0 text-[11px]">
              {t('screen.unsaved')}
            </SettingsChip>
          ) : null}
          <TierChip enforcedBy={cap.enforcedBy} />
        </div>
        <p id={descId} className="mt-0.5 text-xs text-muted-foreground">
          {t(`cap.${id}.description`)}
        </p>
        {stored && !unsaved ? (
          <p className="mt-0.5 text-[11px] text-muted-foreground/80">
            {stored.by?.name
              ? t('screen.changedByAt', { name: stored.by.name, date: changedAt })
              : t('screen.changedAt', { date: changedAt })}
          </p>
        ) : null}
        {capLevelReason ? (
          <p
            id={reasonId}
            className="mt-1 flex items-start gap-1 text-xs text-muted-foreground"
          >
            <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span>{reasonText}</span>
          </p>
        ) : null}
      </div>
    </li>
  );
}
