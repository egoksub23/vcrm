'use client';

import { Check, Minus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import type { RoleMatrixResponse } from '@/app/api/account/roles/route';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
  capabilityI18nId,
  getCapability,
} from '@/lib/auth/capabilities';
import { SettingsChip } from '../settings-chip';
import { ROLE_META } from '../role-meta';
import { groupCapabilities, peopleHolding, rolesHolding, type MemberLite } from './helpers';
import { TierChip } from './tier-chip';

type MembersState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; members: MemberLite[] };

/**
 * Reverse view: pick a capability and see which roles hold it (saved
 * state, owner always) and the named people that means.
 */
export function ByCapabilityView({ data }: { data: RoleMatrixResponse }) {
  const t = useTranslations('Permissions');
  const tRoles = useTranslations('Settings.roles');
  const [capKey, setCapKey] = useState<string>(CAPABILITIES[0].key);
  const [members, setMembers] = useState<MembersState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/account/members', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as { members: MemberLite[] };
      })
      .then((body) => {
        if (!cancelled) setMembers({ status: 'ready', members: body.members });
      })
      .catch(() => {
        if (!cancelled) setMembers({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(
    () =>
      groupCapabilities(
        CAPABILITIES.map((c) => ({ group: c.group, key: c.key })),
      ),
    [],
  );

  const cap = getCapability(capKey) ?? CAPABILITIES[0];
  const id = capabilityI18nId(cap.key);
  const holding = new Set(rolesHolding(data.roles, cap.key));
  const people =
    members.status === 'ready'
      ? peopleHolding(data.roles, members.members, cap.key)
      : [];

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label
          htmlFor="by-capability-select"
          className="text-sm font-medium text-foreground"
        >
          {t('byCapability.pick')}
        </label>
        <Select
          value={capKey}
          onValueChange={(v) => {
            if (v) setCapKey(v);
          }}
        >
          <SelectTrigger id="by-capability-select" className="w-full sm:w-96">
            <SelectValue>{t(`cap.${id}.label`)}</SelectValue>
          </SelectTrigger>
          <SelectContent className="max-h-80">
            {groups.map((g) => (
              <SelectGroup key={g.group}>
                <SelectLabel>{t(`group.${g.group}`)}</SelectLabel>
                {g.items.map((item) => (
                  <SelectItem key={item.key} value={item.key}>
                    {t(`cap.${capabilityI18nId(item.key)}.label`)}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {t(`cap.${id}.label`)}
            </h3>
            <TierChip enforcedBy={cap.enforcedBy} />
          </div>
          <p className="text-sm text-muted-foreground">
            {t(`cap.${id}.description`)}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('byCapability.savedNote')}
          </p>
        </CardContent>
      </Card>

      <section aria-labelledby="by-cap-roles">
        <h4
          id="by-cap-roles"
          className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        >
          {t('byCapability.roles')}
        </h4>
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {data.roles.map((entry) => {
                const has = holding.has(entry.role);
                const isDefault = DEFAULT_CAPABILITIES[entry.role].has(cap.key);
                const Icon = ROLE_META[entry.role].icon;
                return (
                  <li
                    key={entry.role}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                      {tRoles(entry.role)}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {t('screen.peopleCount', { count: entry.memberCount })}
                      </span>
                    </span>
                    {entry.role !== 'owner' && has !== isDefault ? (
                      <SettingsChip
                        variant="admin"
                        className="px-2 py-0 text-[11px]"
                      >
                        {t('screen.changed')}
                      </SettingsChip>
                    ) : null}
                    <span
                      className={
                        has
                          ? 'inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-300'
                          : 'inline-flex items-center gap-1 text-xs text-muted-foreground'
                      }
                    >
                      {has ? (
                        <Check className="size-3.5" aria-hidden />
                      ) : (
                        <Minus className="size-3.5" aria-hidden />
                      )}
                      {entry.role === 'owner'
                        ? t('byCapability.always')
                        : has
                          ? t('byCapability.has')
                          : t('byCapability.hasNot')}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="by-cap-people">
        <h4
          id="by-cap-people"
          className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        >
          {t('byCapability.people')}
        </h4>
        <Card>
          <CardContent className="p-0">
            {members.status === 'loading' ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">
                {t('byCapability.loadingPeople')}
              </p>
            ) : members.status === 'error' ? (
              <p className="px-4 py-4 text-sm text-destructive" role="alert">
                {t('byCapability.peopleFailed')}
              </p>
            ) : people.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">
                {t('byCapability.nobody')}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {people.map((m) => (
                  <li
                    key={m.user_id}
                    className="flex items-center gap-3 px-4 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {m.full_name || m.email || t('byCapability.unnamed')}
                      </p>
                      {m.email && m.full_name ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {m.email}
                        </p>
                      ) : null}
                    </div>
                    <SettingsChip variant={ROLE_META[m.role].variant}>
                      {tRoles(m.role)}
                    </SettingsChip>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
