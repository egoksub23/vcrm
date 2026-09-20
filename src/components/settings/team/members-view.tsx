'use client';

// ============================================================
// MembersView — Settings → Team → Members
//
// One list of everyone in the account: avatar, name, email (Owner/Admin
// only), role lozenge, EVERY team the member belongs to, presence and
// last active. Filters (team, role, status), search and sort narrow it.
// Pending invitations sit at the top. Clicking a person opens the member
// panel; ticking people enables the bulk team actions.
//
// Capabilities (the API and database enforce them again):
//   members.invite       invite / revoke
//   members.change-role  role dropdown in the panel
//   members.remove       remove
//   teams.manage         team memberships, bulk add / remove
// ============================================================

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Loader2,
  Mail,
  MailX,
  Search,
  UserPlus,
  UserMinus,
  Users,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { PresenceDot } from '@/components/presence/presence-dot';
import { useAuth, useCapability } from '@/hooks/use-auth';
import { usePresence } from '@/hooks/use-presence';
import type { AccountRole } from '@/lib/auth/roles';
import { summarize } from '@/lib/presence';
import {
  EMPTY_FILTERS,
  filterInvitations,
  filterMembers,
  hasActiveFilters,
  memberLabel,
  relativeTime,
  sortMembers,
  type MemberSortKey,
  type MemberStatusFilter,
  type RosterFilters,
  type RosterInvitation,
  type RosterMember,
  type SortDir,
  type TeamRef,
} from '@/lib/teams/members';
import { MemberAvatar, RoleLozenge } from './member-parts';
import { MemberSheet } from './member-sheet';
import { MultiSelectPopover, type PickerOption } from './multi-select-popover';
import { RemoveMemberDialog } from './remove-member-dialog';
import { TeamChip, TeamChips } from './team-chips';
import type { TeamRoster } from './use-team-roster';

const ALL_ROLES: AccountRole[] = ['owner', 'admin', 'agent', 'viewer'];

function fmtDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function MembersView({ roster }: { roster: TeamRoster }) {
  const t = useTranslations('Settings.team.members');
  const tRoles = useTranslations('Settings.roles');
  const locale = useLocale();
  const { user } = useAuth();
  const canInvite = useCapability('members.invite');
  const canManageTeams = useCapability('teams.manage');
  const { getPresence, getRow, now } = usePresence();

  const { members, teams, invitations, loading, reload } = roster;

  const [filters, setFilters] = useState<RosterFilters>(EMPTY_FILTERS);
  const [sortKey, setSortKey] = useState<MemberSortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [selected, setSelected] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<RosterMember | null>(null);
  const [bulkAdd, setBulkAdd] = useState<string[]>([]);
  const [bulkRemove, setBulkRemove] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const teamOptions: PickerOption[] = useMemo(
    () => teams.map((tm) => ({ id: tm.id, label: tm.name, color: tm.color })),
    [teams],
  );
  const roleOptions: PickerOption[] = useMemo(
    () => ALL_ROLES.map((r) => ({ id: r, label: tRoles(r) })),
    [tRoles],
  );
  const teamById = useMemo(() => {
    const map = new Map<string, TeamRef>();
    for (const tm of teams) {
      map.set(tm.id, { id: tm.id, name: tm.name, color: tm.color });
    }
    return map;
  }, [teams]);
  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(m.user_id, memberLabel(m));
    return map;
  }, [members]);

  const visibleMembers = useMemo(
    () => sortMembers(filterMembers(members, filters), sortKey, sortDir),
    [members, filters, sortKey, sortDir],
  );
  const visibleInvites = useMemo(
    () => (canInvite ? filterInvitations(invitations, filters) : []),
    [canInvite, invitations, filters],
  );

  const selectedVisible = visibleMembers.filter((m) =>
    selected.includes(m.user_id),
  );
  const allSelected =
    visibleMembers.length > 0 && selectedVisible.length === visibleMembers.length;
  const someSelected = selectedVisible.length > 0 && !allSelected;

  function patch(p: Partial<RosterFilters>) {
    setFilters((f) => ({ ...f, ...p }));
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? visibleMembers.map((m) => m.user_id) : []);
  }
  function toggleOne(id: string, checked: boolean) {
    setSelected((s) =>
      checked ? (s.includes(id) ? s : [...s, id]) : s.filter((x) => x !== id),
    );
  }

  function presenceText(m: RosterMember): string {
    const p = getPresence(m.user_id);
    if (p === 'online') return t('presence.online');
    if (p === 'away') return t('presence.away');
    const when = relativeTime(
      getRow(m.user_id)?.last_seen_at ?? m.last_active,
      now,
      locale,
    );
    return when ? t('presence.offlineSince', { when }) : t('presence.offline');
  }

  function lastActiveText(m: RosterMember): string {
    if (getPresence(m.user_id) === 'online') return t('activeNow');
    return (
      relativeTime(getRow(m.user_id)?.last_seen_at ?? m.last_active, now, locale) ??
      t('never')
    );
  }

  async function applyBulk(action: 'add' | 'remove', teamIds: string[]) {
    if (selected.length === 0 || teamIds.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await fetch('/api/account/members/bulk-teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          user_ids: selected,
          team_ids: teamIds,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('bulkFailed'));
        return;
      }
      const { changed } = (await res.json()) as { changed: number };
      toast.success(
        action === 'add'
          ? t('bulkAdded', { count: changed })
          : t('bulkRemoved', { count: changed }),
      );
      if (action === 'add') setBulkAdd([]);
      else setBulkRemove([]);
      await reload();
    } catch (err) {
      console.error('[MembersView] bulk teams error:', err);
      toast.error(t('networkError'));
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleRevoke(inv: RosterInvitation) {
    setRevokingId(inv.id);
    try {
      const res = await fetch(`/api/account/invitations/${inv.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('revokeFailed'));
        return;
      }
      toast.success(t('revokedToast'));
      await reload();
    } catch (err) {
      console.error('[MembersView] revoke error:', err);
      toast.error(t('networkError'));
    } finally {
      setRevokingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  const counts = summarize(members.map((m) => getPresence(m.user_id)));
  const openMember = members.find((m) => m.user_id === openId) ?? null;
  const filtered = hasActiveFilters(filters);
  const gridCols = canManageTeams
    ? 'md:grid-cols-[1.25rem_minmax(0,1.4fr)_6.5rem_minmax(0,2fr)_7rem]'
    : 'md:grid-cols-[minmax(0,1.4fr)_6.5rem_minmax(0,2fr)_7rem]';

  return (
    <div className="space-y-4">
      {/* Filters, search, sort */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.search}
            onChange={(e) => patch({ search: e.target.value })}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="border-border bg-card pl-8 text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <MultiSelectPopover
          options={teamOptions}
          selected={filters.teamIds}
          onChange={(teamIds) => patch({ teamIds })}
          label={t('filterTeam')}
          searchPlaceholder={t('searchTeams')}
          emptyLabel={t('noTeamsYet')}
        />
        <MultiSelectPopover
          options={roleOptions}
          selected={filters.roles}
          onChange={(ids) => patch({ roles: ids as AccountRole[] })}
          label={t('filterRole')}
          emptyLabel={t('noRoles')}
        />
        {canInvite && (
          <Select
            value={filters.status}
            onValueChange={(v) => v && patch({ status: v as MemberStatusFilter })}
          >
            <SelectTrigger
              className="w-36 border-border bg-card text-foreground"
              aria-label={t('filterStatus')}
            >
              <SelectValue>{t(`status.${filters.status}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('status.all')}</SelectItem>
              <SelectItem value="active">{t('status.active')}</SelectItem>
              <SelectItem value="pending">{t('status.pending')}</SelectItem>
            </SelectContent>
          </Select>
        )}
        <Select
          value={sortKey}
          onValueChange={(v) => v && setSortKey(v as MemberSortKey)}
        >
          <SelectTrigger
            className="w-32 border-border bg-card text-foreground"
            aria-label={t('sortBy')}
          >
            <SelectValue>{t(`sort.${sortKey}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name">{t('sort.name')}</SelectItem>
            <SelectItem value="role">{t('sort.role')}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
          aria-label={sortDir === 'asc' ? t('sortAsc') : t('sortDesc')}
          title={sortDir === 'asc' ? t('sortAsc') : t('sortDesc')}
          className="border-border text-muted-foreground hover:bg-muted"
        >
          {sortDir === 'asc' ? (
            <ArrowDownAZ className="size-4" />
          ) : (
            <ArrowUpAZ className="size-4" />
          )}
        </Button>
        {filtered && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setFilters(EMPTY_FILTERS)}
            className="text-muted-foreground"
          >
            <X className="size-4" />
            {t('clearFilters')}
          </Button>
        )}
      </div>

      {/* Presence summary + count */}
      {members.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <PresenceDot status="online" />
            {counts.online} {t('presence.onlineCount')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <PresenceDot status="away" />
            {counts.away} {t('presence.awayCount')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <PresenceDot status="offline" />
            {counts.offline} {t('presence.offlineCount')}
          </span>
          <span className="text-muted-foreground/70">
            ·{' '}
            {filtered
              ? t('showingCount', {
                  shown: visibleMembers.length,
                  total: members.length,
                })
              : t('memberCount', { count: members.length })}
          </span>
        </div>
      )}

      {/* Bulk team actions */}
      {canManageTeams && selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
          <span className="text-sm font-medium text-foreground">
            {t('selectedCount', { count: selected.length })}
          </span>
          <MultiSelectPopover
            options={teamOptions}
            selected={bulkAdd}
            onChange={setBulkAdd}
            label={t('bulkAddTo')}
            icon={<UserPlus className="size-3.5" />}
            searchPlaceholder={t('searchTeams')}
            emptyLabel={t('noTeamsYet')}
            footer={
              <Button
                type="button"
                size="sm"
                className="w-full"
                disabled={bulkAdd.length === 0 || bulkBusy}
                onClick={() => applyBulk('add', bulkAdd)}
              >
                {bulkBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  t('bulkApplyAdd')
                )}
              </Button>
            }
          />
          <MultiSelectPopover
            options={teamOptions}
            selected={bulkRemove}
            onChange={setBulkRemove}
            label={t('bulkRemoveFrom')}
            icon={<UserMinus className="size-3.5" />}
            searchPlaceholder={t('searchTeams')}
            emptyLabel={t('noTeamsYet')}
            footer={
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="w-full"
                disabled={bulkRemove.length === 0 || bulkBusy}
                onClick={() => applyBulk('remove', bulkRemove)}
              >
                {bulkBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  t('bulkApplyRemove')
                )}
              </Button>
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setSelected([])}
            className="ml-auto text-muted-foreground"
          >
            {t('clearSelection')}
          </Button>
        </div>
      )}

      {/* Pending invitations, at the top */}
      {canInvite && visibleInvites.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Mail className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">
              {t('pendingInvitations')}
            </h3>
            <Badge className="border-border bg-muted text-muted-foreground">
              {visibleInvites.length}
            </Badge>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            {t('inviteHint')}
          </p>
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y divide-border">
                {visibleInvites.map((inv) => {
                  const inviteTeams = inv.team_ids
                    .map((id) => teamById.get(id))
                    .filter((x): x is TeamRef => !!x);
                  const inviter = inv.created_by_user_id
                    ? nameById.get(inv.created_by_user_id)
                    : null;
                  const expired = new Date(inv.expires_at).getTime() <= now;
                  return (
                    <li
                      key={inv.id}
                      className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:gap-4"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <Mail className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {inv.label || t('untitledInvite')}
                          </span>
                          <RoleLozenge role={inv.role} />
                          <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-300">
                            {t('status.pendingBadge')}
                          </Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {inviter
                            ? `${t('invitedBy', { name: inviter })} · `
                            : ''}
                          {expired
                            ? t('expired')
                            : t('expiresOn', {
                                date: fmtDate(inv.expires_at, locale),
                              })}
                        </p>
                      </div>
                      <div className="min-w-0 md:w-64">
                        {inviteTeams.length > 0 ? (
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="text-xs text-muted-foreground">
                              {t('willJoin')}
                            </span>
                            {inviteTeams.slice(0, 3).map((tm) => (
                              <TeamChip key={tm.id} team={tm} />
                            ))}
                            {inviteTeams.length > 3 && (
                              <span className="text-xs text-muted-foreground">
                                +{inviteTeams.length - 3}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {t('noTeamsToJoin')}
                          </span>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={revokingId === inv.id}
                        onClick={() => handleRevoke(inv)}
                        className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                      >
                        <MailX className="size-4" />
                        {t('revoke')}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Members */}
      {filters.status !== 'pending' && (
        <Card>
          <CardContent className="p-0">
            {visibleMembers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Users className="size-6 text-muted-foreground" />
                <p className="mt-2 text-sm text-muted-foreground">
                  {filtered ? t('noMatches') : t('noMembers')}
                </p>
              </div>
            ) : (
              <>
                {/* Column headers (desktop) */}
                <div
                  className={`hidden items-center gap-4 border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground md:grid ${gridCols}`}
                >
                  {canManageTeams && (
                    <Checkbox
                      checked={allSelected}
                      indeterminate={someSelected}
                      onCheckedChange={(c) => toggleAll(c === true)}
                      aria-label={t('selectAll')}
                    />
                  )}
                  <span>{t('col.member')}</span>
                  <span>{t('col.role')}</span>
                  <span>{t('col.teams')}</span>
                  <span>{t('col.lastActive')}</span>
                </div>
                <ul className="divide-y divide-border">
                  {visibleMembers.map((m) => {
                    const isSelf = m.user_id === user?.id;
                    const presence = getPresence(m.user_id);
                    return (
                      <li
                        key={m.user_id}
                        className={`flex flex-col gap-2 px-4 py-3 md:grid md:items-center md:gap-4 ${gridCols}`}
                      >
                        {canManageTeams && (
                          <Checkbox
                            checked={selected.includes(m.user_id)}
                            onCheckedChange={(c) =>
                              toggleOne(m.user_id, c === true)
                            }
                            aria-label={t('selectMember', {
                              name: m.full_name || t('unnamed'),
                            })}
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => setOpenId(m.user_id)}
                          className="flex min-w-0 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          aria-label={t('openMember', {
                            name: m.full_name || m.email || t('unnamed'),
                          })}
                        >
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span className="shrink-0">
                                  <MemberAvatar
                                    name={m.full_name}
                                    email={m.email}
                                    src={m.avatar_url}
                                    presence={presence}
                                    presenceLabel={presenceText(m)}
                                  />
                                </span>
                              }
                            />
                            <TooltipContent>{presenceText(m)}</TooltipContent>
                          </Tooltip>
                          <span className="min-w-0">
                            <span className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium text-foreground">
                                {m.full_name || t('unnamed')}
                              </span>
                              {isSelf && (
                                <Badge className="border-border bg-muted text-[10px] tracking-wide text-muted-foreground uppercase">
                                  {t('you')}
                                </Badge>
                              )}
                            </span>
                            {m.email && (
                              <span className="block truncate text-xs text-muted-foreground">
                                {m.email}
                              </span>
                            )}
                          </span>
                        </button>
                        <div>
                          <RoleLozenge role={m.role} />
                        </div>
                        <TeamChips teams={m.teams} />
                        <span className="text-xs text-muted-foreground">
                          {lastActiveText(m)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <MemberSheet
        member={openMember}
        roster={roster}
        onClose={() => setOpenId(null)}
        onRemove={(m) => {
          setOpenId(null);
          setRemoving(m);
        }}
        presenceText={openMember ? presenceText(openMember) : ''}
      />

      <RemoveMemberDialog
        member={removing}
        members={members}
        teamCount={removing?.teams.length ?? 0}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        onRemoved={async () => {
          setRemoving(null);
          setSelected((s) => s.filter((id) => id !== removing?.user_id));
          await reload();
        }}
      />
    </div>
  );
}
