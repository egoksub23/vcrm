'use client';

import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

import type { RoleMatrixEntry } from '@/app/api/account/roles/route';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { capabilityI18nId } from '@/lib/auth/capabilities';
import type { AccountRole } from '@/lib/auth/roles';
import { CapabilityRow } from './capability-row';
import {
  differsFromDefault,
  filterCapabilities,
  groupCapabilities,
  rowBlockReason,
} from './helpers';
import { TierLegend } from './tier-chip';

interface CapabilityListProps {
  entry: RoleMatrixEntry;
  editorRole: AccountRole;
  editorCaps: ReadonlySet<string>;
  saved: ReadonlySet<string>;
  draft: ReadonlySet<string>;
  query: string;
  onlyChanged: boolean;
  onQueryChange: (q: string) => void;
  onOnlyChangedChange: (v: boolean) => void;
  onToggle: (cap: string, next: boolean) => void;
}

/** Search + "only changed" toolbar, the tier legend and the grouped rows. */
export function CapabilityList({
  entry,
  editorRole,
  editorCaps,
  saved,
  draft,
  query,
  onlyChanged,
  onQueryChange,
  onOnlyChangedChange,
  onToggle,
}: CapabilityListProps) {
  const t = useTranslations('Permissions');
  const role = entry.role;

  const groups = useMemo(() => {
    const caps = filterCapabilities({
      query,
      onlyChanged,
      role,
      draft,
      text: (cap) => {
        const id = capabilityI18nId(cap.key);
        return {
          label: t(`cap.${id}.label`),
          description: t(`cap.${id}.description`),
        };
      },
    });
    return groupCapabilities(caps);
  }, [query, onlyChanged, role, draft, t]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t('screen.searchPlaceholder')}
            aria-label={t('screen.searchLabel')}
            className="pl-8"
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <Switch
            checked={onlyChanged}
            onCheckedChange={onOnlyChangedChange}
            aria-label={t('screen.onlyChanged')}
          />
          <span>{t('screen.onlyChanged')}</span>
        </label>
      </div>

      <TierLegend />

      {groups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              {onlyChanged && !query.trim()
                ? t('screen.noChanged')
                : t('screen.noResults')}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onQueryChange('');
                onOnlyChangedChange(false);
              }}
            >
              {t('screen.clearFilters')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        groups.map((block) => (
          <section key={block.group} aria-labelledby={`group-${block.group}`}>
            <h4
              id={`group-${block.group}`}
              className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
            >
              {t(`group.${block.group}`)}
            </h4>
            <Card>
              <CardContent className="p-0">
                <ul className="divide-y divide-border">
                  {block.items.map((cap) => {
                    const on = draft.has(cap.key);
                    return (
                      <CapabilityRow
                        key={cap.key}
                        cap={cap}
                        targetRole={role}
                        on={on}
                        changedFromDefault={differsFromDefault(
                          role,
                          draft,
                          cap.key,
                        )}
                        unsaved={saved.has(cap.key) !== on}
                        reason={rowBlockReason({
                          editorRole,
                          editorCaps,
                          targetRole: role,
                          cap: cap.key,
                          on,
                          saved,
                        })}
                        stored={entry.changed[cap.key]}
                        onToggle={(next) => onToggle(cap.key, next)}
                      />
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          </section>
        ))
      )}
    </div>
  );
}
