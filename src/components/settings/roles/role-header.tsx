'use client';

import { History, Lock, RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { RoleMatrixEntry } from '@/app/api/account/roles/route';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { CapabilityPreset } from '@/lib/auth/capabilities';
import { SettingsChip } from '../settings-chip';
import { ROLE_META } from '../role-meta';
import { PresetMenu } from './preset-menu';

interface RoleHeaderProps {
  entry: RoleMatrixEntry;
  /** Draft already equals the role default, so Reset would do nothing. */
  atDefault: boolean;
  onApplyPreset: (preset: CapabilityPreset) => void;
  onReset: () => void;
  onOpenLog: () => void;
}

/** Top of the right panel: role name, description, people, actions. */
export function RoleHeader({
  entry,
  atDefault,
  onApplyPreset,
  onReset,
  onOpenLog,
}: RoleHeaderProps) {
  const t = useTranslations('Permissions');
  const tRoles = useTranslations('Settings.roles');
  const meta = ROLE_META[entry.role];
  const Icon = meta.icon;
  const isOwner = entry.role === 'owner';
  const locked = isOwner || !entry.editable;

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <h3 className="text-base font-semibold text-foreground">
                {tRoles(entry.role)}
              </h3>
              <SettingsChip variant={meta.variant}>
                {t('screen.peopleCount', { count: entry.memberCount })}
              </SettingsChip>
              {locked ? (
                <SettingsChip>
                  <Lock />
                  {isOwner ? t('screen.locked') : t('screen.readOnlyChip')}
                </SettingsChip>
              ) : null}
            </div>
            <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
              {t(`role.${entry.role}.description`)}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <PresetMenu
              role={entry.role}
              disabled={locked}
              onApply={onApplyPreset}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={onReset}
              disabled={locked || atDefault}
            >
              <RotateCcw className="size-3.5" />
              {t('screen.resetDefault')}
            </Button>
            <Button variant="outline" size="sm" onClick={onOpenLog}>
              <History className="size-3.5" />
              {t('screen.viewLog')}
            </Button>
          </div>
        </div>

        {locked ? (
          <p
            className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
            role="note"
          >
            <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {isOwner
                ? t('screen.reason.owner-locked')
                : t('screen.reason.role-not-editable')}
            </span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
