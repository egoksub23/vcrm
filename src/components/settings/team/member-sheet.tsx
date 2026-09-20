'use client';

// ============================================================
// MemberSheet — the side panel for one person.
//
//   Role          dropdown limited to roles strictly below the caller's;
//                 disabled with a tooltip that says why otherwise
//   Teams         multi-select, every change saved immediately
//   Access        how many capabilities their role holds + link to
//                 Roles & permissions
//   Open work     conversations and tickets assigned to them
//   Remove        opens the confirm dialog (parent), which shows the counts
// ============================================================

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  ExternalLink,
  Inbox,
  Loader2,
  ShieldCheck,
  Ticket,
  Trash2,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useAuth, useCapability } from '@/hooks/use-auth';
import type { AccountRole } from '@/lib/auth/roles';
import {
  canActOnMember,
  rolesBelow,
  type RosterMember,
} from '@/lib/teams/members';
import { MemberAvatar, RoleLozenge } from './member-parts';
import { MultiSelectPopover } from './multi-select-popover';
import { TeamChips } from './team-chips';
import type { TeamRoster } from './use-team-roster';

export function MemberSheet({
  member,
  roster,
  onClose,
  onRemove,
  presenceText,
}: {
  member: RosterMember | null;
  roster: TeamRoster;
  onClose: () => void;
  onRemove: (member: RosterMember) => void;
  presenceText: string;
}) {
  return (
    <Sheet
      open={member !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        {member ? (
          <MemberPanel
            // A fresh panel (and fresh optimistic state) per person.
            key={member.user_id}
            member={member}
            roster={roster}
            onRemove={onRemove}
            presenceText={presenceText}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function MemberPanel({
  member,
  roster,
  onRemove,
  presenceText,
}: {
  member: RosterMember;
  roster: TeamRoster;
  onRemove: (member: RosterMember) => void;
  presenceText: string;
}) {
  const t = useTranslations('Settings.team.sheet');
  const tRoles = useTranslations('Settings.roles');
  const locale = useLocale();
  const { user, accountRole } = useAuth();
  const canChangeRole = useCapability('members.change-role');
  const canRemove = useCapability('members.remove');
  const canManageTeams = useCapability('teams.manage');
  const canSeeRoles = useCapability('roles.manage');

  const [pendingRole, setPendingRole] = useState<AccountRole | null>(null);
  const [savingRole, setSavingRole] = useState(false);
  // Team ids while a save is in flight (or just saved, until the reload
  // lands); null means "show what the server said".
  const [optimisticTeams, setOptimisticTeams] = useState<string[] | null>(null);
  const [savingTeams, setSavingTeams] = useState(false);

  const { teams, capabilityCounts, capabilityTotal, reload } = roster;

  const isSelf = member.user_id === user?.id;
  const acting = canActOnMember(accountRole, user?.id, member);
  const assignable = rolesBelow(accountRole);
  const roleEditable = canChangeRole && acting && assignable.length > 0;
  const shownRole = pendingRole ?? member.role;

  const lockReason = isSelf
    ? t('roleLocked.self')
    : member.role === 'owner'
      ? t('roleLocked.owner')
      : !canChangeRole
        ? t('roleLocked.capability')
        : t('roleLocked.hierarchy');

  const teamIds = optimisticTeams ?? member.teams.map((tm) => tm.id);
  const shownTeams = teams
    .filter((tm) => teamIds.includes(tm.id))
    .map((tm) => ({ id: tm.id, name: tm.name, color: tm.color }));
  const name = member.full_name || member.email || t('unnamed');

  async function changeRole(next: AccountRole) {
    if (next === member.role || savingRole) return;
    setPendingRole(next);
    setSavingRole(true);
    try {
      const res = await fetch(`/api/account/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: next }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('roleFailed'));
        setPendingRole(null);
        return;
      }
      toast.success(t('roleUpdated', { name, role: tRoles(next) }));
      await reload();
      setPendingRole(null);
    } catch (err) {
      console.error('[MemberSheet] role change error:', err);
      toast.error(t('networkError'));
      setPendingRole(null);
    } finally {
      setSavingRole(false);
    }
  }

  async function saveTeams(next: string[]) {
    if (savingTeams) return;
    setOptimisticTeams(next);
    setSavingTeams(true);
    try {
      const res = await fetch(`/api/account/members/${member.user_id}/teams`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_ids: next }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('teamsFailed'));
        setOptimisticTeams(null);
        return;
      }
      await reload();
      setOptimisticTeams(null);
    } catch (err) {
      console.error('[MemberSheet] team save error:', err);
      toast.error(t('networkError'));
      setOptimisticTeams(null);
    } finally {
      setSavingTeams(false);
    }
  }

  const enabled = capabilityCounts[member.role];
  const joined = new Date(member.joined_at).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <>
      <SheetHeader className="border-b border-border p-4 pr-12">
        <div className="flex items-center gap-3">
          <MemberAvatar
            name={member.full_name}
            email={member.email}
            src={member.avatar_url}
            className="size-12"
          />
          <div className="min-w-0">
            <SheetTitle className="truncate text-base">{name}</SheetTitle>
            <SheetDescription className="truncate">
              {member.email ?? presenceText}
            </SheetDescription>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <RoleLozenge role={member.role} />
          {member.email ? <span>{presenceText}</span> : null}
          <span>{t('joined', { date: joined })}</span>
        </div>
      </SheetHeader>

      <div className="space-y-6 p-4">
        {/* Role */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{t('role')}</h3>
          {roleEditable ? (
            <Select
              value={shownRole}
              onValueChange={(v) => v && changeRole(v as AccountRole)}
            >
              <SelectTrigger
                className="w-full border-border bg-muted text-foreground"
                disabled={savingRole}
                aria-label={t('role')}
              >
                <SelectValue>{tRoles(shownRole)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {assignable.map((r) => (
                  <SelectItem key={r} value={r}>
                    {tRoles(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={<span tabIndex={0} className="block w-full" />}
              >
                <Select value={member.role}>
                  <SelectTrigger
                    className="pointer-events-none w-full border-border bg-muted text-foreground"
                    disabled
                    aria-label={t('role')}
                  >
                    <SelectValue>{tRoles(member.role)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={member.role}>
                      {tRoles(member.role)}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </TooltipTrigger>
              <TooltipContent>{lockReason}</TooltipContent>
            </Tooltip>
          )}
          <p className="text-xs text-muted-foreground">
            {tRoles(`${member.role}Hint` as 'adminHint')}
          </p>
        </section>

        {/* Teams */}
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {t('teams')}
            </h3>
            {savingTeams && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            )}
          </div>
          <TeamChips teams={shownTeams} limit={50} />
          {canManageTeams ? (
            <MultiSelectPopover
              options={teams.map((tm) => ({
                id: tm.id,
                label: tm.name,
                color: tm.color,
              }))}
              selected={teamIds}
              onChange={saveTeams}
              disabled={savingTeams}
              label={t('editTeams')}
              searchPlaceholder={t('searchTeams')}
              emptyLabel={t('noTeamsYet')}
              className="w-full"
            />
          ) : (
            <p className="text-xs text-muted-foreground">{t('teamsReadOnly')}</p>
          )}
        </section>

        {/* Effective access */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{t('access')}</h3>
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-3">
            <ShieldCheck className="size-5 shrink-0 text-primary" />
            <div className="min-w-0 flex-1 text-sm">
              <p className="text-foreground">
                {enabled !== undefined && capabilityTotal > 0
                  ? t('accessSummary', {
                      role: tRoles(member.role),
                      enabled,
                      total: capabilityTotal,
                    })
                  : t('accessUnknown', { role: tRoles(member.role) })}
              </p>
              {canSeeRoles ? (
                <Link
                  href="/settings?tab=roles"
                  className="mt-0.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  {t('reviewRoles')}
                  <ExternalLink className="size-3" />
                </Link>
              ) : null}
            </div>
          </div>
        </section>

        {/* Open work */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{t('work')}</h3>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Inbox className="size-3.5" />
                {t('openConversations')}
              </div>
              <div className="mt-1 text-2xl font-semibold text-foreground">
                {member.open_conversations}
              </div>
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Ticket className="size-3.5" />
                {t('openTickets')}
              </div>
              <div className="mt-1 text-2xl font-semibold text-foreground">
                {member.open_tickets}
              </div>
            </div>
          </div>
        </section>

        {/* Remove */}
        {canRemove && acting ? (
          <section className="space-y-2 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onRemove(member)}
              className="w-full border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
            >
              <Trash2 className="size-4" />
              {t('remove')}
            </Button>
          </section>
        ) : null}
      </div>
    </>
  );
}
