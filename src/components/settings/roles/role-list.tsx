'use client';

import { Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { RoleMatrixEntry } from '@/app/api/account/roles/route';
import type { AccountRole } from '@/lib/auth/roles';
import { cn } from '@/lib/utils';
import { SettingsChip } from '../settings-chip';
import { ROLE_META } from '../role-meta';

interface RoleListProps {
  roles: readonly RoleMatrixEntry[];
  selected: AccountRole;
  /** Number of unsaved changes per role (drafts are kept per role). */
  unsaved: Partial<Record<AccountRole, number>>;
  onSelect: (role: AccountRole) => void;
}

/**
 * The four roles. A vertical list on wide screens; on phones it becomes
 * a compact 2 x 2 (then 4 x 1) segmented grid so nothing scrolls sideways.
 */
export function RoleList({ roles, selected, unsaved, onSelect }: RoleListProps) {
  const t = useTranslations('Permissions');
  const tRoles = useTranslations('Settings.roles');

  return (
    <nav aria-label={t('screen.rolesNav')}>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-1">
        {roles.map((entry) => {
          const meta = ROLE_META[entry.role];
          const Icon = meta.icon;
          const isOwner = entry.role === 'owner';
          const isSelected = entry.role === selected;
          const pending = unsaved[entry.role] ?? 0;
          return (
            <li key={entry.role}>
              <button
                type="button"
                onClick={() => onSelect(entry.role)}
                aria-current={isSelected ? 'true' : undefined}
                className={cn(
                  'flex w-full flex-col gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  isSelected
                    ? 'border-primary-soft-2 bg-primary-soft'
                    : 'border-border bg-card hover:bg-muted',
                )}
              >
                <span className="flex items-center gap-2">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {tRoles(entry.role)}
                  </span>
                  {isOwner ? (
                    <Lock
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-label={t('screen.locked')}
                    />
                  ) : null}
                  {pending > 0 ? (
                    <span
                      className="size-2 shrink-0 rounded-full bg-amber-500"
                      role="img"
                      aria-label={t('screen.roleUnsaved', { count: pending })}
                    />
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('screen.peopleCount', { count: entry.memberCount })}
                </span>
                {isOwner ? (
                  <span className="hidden text-xs text-muted-foreground lg:block">
                    {t('screen.ownerNote')}
                  </span>
                ) : null}
                {!isOwner && !entry.editable ? (
                  <SettingsChip className="w-fit px-2 py-0 text-[11px]">
                    {t('screen.readOnlyChip')}
                  </SettingsChip>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
