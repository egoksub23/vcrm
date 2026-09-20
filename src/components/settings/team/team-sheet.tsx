'use client';

// ============================================================
// TeamSheet — the side panel for one team: who is on it, with a quick
// "Add member" combobox (searchable list of people not yet on the team)
// and a remove button per person. Adding and removing need teams.manage
// and save immediately.
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { Inbox, Loader2, Search, UserPlus, Users, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { RequireCapability } from '@/components/auth/require-capability';
import {
  addableMembers,
  memberLabel,
  membersOfTeam,
} from '@/lib/teams/members';
import type { Team } from '@/types';
import { MemberAvatar, RoleLozenge } from './member-parts';
import type { TeamRoster } from './use-team-roster';

export function TeamSheet({
  team,
  roster,
  onClose,
}: {
  team: Team | null;
  roster: TeamRoster;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={team !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        {team ? <TeamPanel key={team.id} team={team} roster={roster} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function TeamPanel({ team, roster }: { team: Team; roster: TeamRoster }) {
  const t = useTranslations('Settings.team.teamSheet');
  const { members, reload } = roster;
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const people = membersOfTeam(members, team.id);
  const candidates = addableMembers(members, team.id, query);

  async function add(userId: string) {
    setBusyId(userId);
    try {
      const res = await fetch(`/api/account/teams/${team.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('addFailed'));
        return;
      }
      setQuery('');
      await reload();
    } catch (err) {
      console.error('[TeamSheet] add member error:', err);
      toast.error(t('networkError'));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(userId: string) {
    setBusyId(userId);
    try {
      const res = await fetch(
        `/api/account/teams/${team.id}/members/${userId}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('removeFailed'));
        return;
      }
      await reload();
    } catch (err) {
      console.error('[TeamSheet] remove member error:', err);
      toast.error(t('networkError'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <SheetHeader className="border-b border-border p-4 pr-12">
        <div className="flex items-center gap-2.5">
          <span
            className="size-3.5 shrink-0 rounded-full"
            style={{ backgroundColor: team.color }}
            aria-hidden
          />
          <SheetTitle className="truncate text-base">{team.name}</SheetTitle>
        </div>
        <SheetDescription>
          {team.description || t('noDescription')}
        </SheetDescription>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Users className="size-3.5" />
            {t('memberCount', { count: people.length })}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Inbox className="size-3.5" />
            {t('openConversations', { count: team.open_conversations ?? 0 })}
          </span>
        </div>
      </SheetHeader>

      <div className="space-y-4 p-4">
        <RequireCapability cap="teams.manage">
          <Popover
            open={addOpen}
            onOpenChange={(open) => {
              setAddOpen(open);
              if (!open) setQuery('');
            }}
          >
            <PopoverTrigger
              render={
                <Button variant="outline" className="w-full justify-center" />
              }
            >
              <UserPlus className="size-4" />
              {t('addMember')}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 p-0">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <Search className="size-3.5 shrink-0 text-muted-foreground" />
                <Input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('searchMembers')}
                  aria-label={t('searchMembers')}
                  className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                />
              </div>
              {candidates.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                  {members.length > 0 && people.length === members.length
                    ? t('everyoneOnTeam')
                    : t('noMatches')}
                </p>
              ) : (
                <ul className="max-h-64 overflow-y-auto py-1">
                  {candidates.map((m) => (
                    <li key={m.user_id}>
                      <button
                        type="button"
                        onClick={() => add(m.user_id)}
                        disabled={busyId === m.user_id}
                        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-muted/50 disabled:opacity-50"
                      >
                        <MemberAvatar
                          name={m.full_name}
                          email={m.email}
                          src={m.avatar_url}
                          className="size-7"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-popover-foreground">
                            {memberLabel(m) || t('unnamed')}
                          </span>
                          {m.email && m.full_name ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {m.email}
                            </span>
                          ) : null}
                        </span>
                        {busyId === m.user_id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </PopoverContent>
          </Popover>
        </RequireCapability>

        {people.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t('noMembersYet')}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {people.map((m) => (
              <li
                key={m.user_id}
                className="flex items-center gap-3 rounded-md bg-muted/50 px-2.5 py-2"
              >
                <MemberAvatar
                  name={m.full_name}
                  email={m.email}
                  src={m.avatar_url}
                  className="size-8"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">
                    {m.full_name || m.email || t('unnamed')}
                  </span>
                  {m.email && m.full_name ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {m.email}
                    </span>
                  ) : null}
                </span>
                <RoleLozenge role={m.role} />
                <RequireCapability cap="teams.manage">
                  <button
                    type="button"
                    onClick={() => remove(m.user_id)}
                    disabled={busyId === m.user_id}
                    aria-label={t('removeMemberAria', {
                      name: m.full_name || m.email || t('unnamed'),
                    })}
                    className="shrink-0 rounded-full p-1 text-muted-foreground opacity-70 transition-opacity hover:bg-black/10 hover:opacity-100 disabled:opacity-40 dark:hover:bg-white/10"
                  >
                    {busyId === m.user_id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <X className="size-3.5" />
                    )}
                  </button>
                </RequireCapability>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
