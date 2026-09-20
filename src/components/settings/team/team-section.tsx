'use client';

// ============================================================
// TeamSection — Settings → Team
//
// Team members and Teams used to be two settings pages. They are one
// area now, with a segmented control: Members | Teams. The view lives in
// the URL (`?tab=team&view=members|teams`); the old `?tab=members` and
// `?tab=teams` links still land here (see resolveTeamView).
//
// The header action follows the view: Invite member (members.invite) on
// Members, Create team (teams.manage) on Teams. Everyone who can open
// Settings can read both views; every edit control is capability-gated
// and the API and database check again.
// ============================================================

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RequireCapability } from '@/components/auth/require-capability';
import type { Team } from '@/types';
import { SettingsPanelHead } from '../settings-panel-head';
import {
  resolveTeamView,
  type TeamView,
} from '../settings-sections';
import { InviteDialog } from './invite-dialog';
import { MembersView } from './members-view';
import { TeamsView } from './teams-view';
import { useTeamRoster } from './use-team-roster';

export function TeamSection() {
  const t = useTranslations('Settings.team');
  const router = useRouter();
  const searchParams = useSearchParams();
  const roster = useTeamRoster();

  const view = resolveTeamView(searchParams.get('tab'), searchParams.get('view'));

  const [inviteOpen, setInviteOpen] = useState(false);
  const [teamFormOpen, setTeamFormOpen] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);

  function setView(next: TeamView) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'team');
    params.set('view', next);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  }

  function openCreateTeam() {
    setEditingTeam(null);
    setTeamFormOpen(true);
  }

  return (
    <section className="animate-in fade-in-50 space-y-5 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          view === 'members' ? (
            <RequireCapability cap="members.invite">
              <Button onClick={() => setInviteOpen(true)}>
                <Plus className="size-4" />
                {t('inviteMember')}
              </Button>
            </RequireCapability>
          ) : (
            <RequireCapability cap="teams.manage">
              <Button onClick={openCreateTeam}>
                <Plus className="size-4" />
                {t('createTeam')}
              </Button>
            </RequireCapability>
          )
        }
        className="mb-0"
      />

      <Tabs
        value={view}
        onValueChange={(v) => {
          if (v === 'members' || v === 'teams') setView(v);
        }}
      >
        <TabsList aria-label={t('viewsAria')}>
          <TabsTrigger value="members">
            {t('views.members')}
            {!roster.loading && (
              <span className="ml-1.5 text-xs text-muted-foreground">
                {roster.members.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="teams">
            {t('views.teams')}
            {!roster.loading && (
              <span className="ml-1.5 text-xs text-muted-foreground">
                {roster.teams.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {view === 'members' ? (
        <MembersView roster={roster} />
      ) : (
        <TeamsView
          roster={roster}
          formOpen={teamFormOpen}
          onFormOpenChange={setTeamFormOpen}
          editing={editingTeam}
          onEdit={(team) => {
            setEditingTeam(team);
            setTeamFormOpen(true);
          }}
        />
      )}

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        teams={roster.teams}
        onCreated={roster.reload}
      />
    </section>
  );
}
