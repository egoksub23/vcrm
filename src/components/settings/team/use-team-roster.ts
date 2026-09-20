'use client';

// ============================================================
// useTeamRoster — everything the Team screen shows, loaded together:
//   members  (with every team, last active, open work) — ONE call
//   teams    (colour, description, roster, open conversations)
//   invites  (pending links; only for people who may invite)
//
// Mutations elsewhere call `reload()` (silent, no spinner) so the
// members list, the teams view and the open panels stay in step.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { useCapability } from '@/hooks/use-auth';
import type { RosterInvitation, RosterMember } from '@/lib/teams/members';
import type { Team } from '@/types';

export interface TeamRoster {
  members: RosterMember[];
  teams: Team[];
  invitations: RosterInvitation[];
  /** Capabilities enabled per role (for the access summary). */
  capabilityCounts: Record<string, number>;
  capabilityTotal: number;
  loading: boolean;
  reload: () => Promise<void>;
}

export function useTeamRoster(): TeamRoster {
  const t = useTranslations('Settings.team');
  const canInvite = useCapability('members.invite');
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [invitations, setInvitations] = useState<RosterInvitation[]>([]);
  const [capabilityCounts, setCapabilityCounts] = useState<
    Record<string, number>
  >({});
  const [capabilityTotal, setCapabilityTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [mres, tres, ires] = await Promise.all([
        fetch('/api/account/members', { cache: 'no-store' }),
        fetch('/api/account/teams', { cache: 'no-store' }),
        canInvite
          ? fetch('/api/account/invitations', { cache: 'no-store' })
          : Promise.resolve(null),
      ]);
      // A newer reload started while this one was in flight: drop this one.
      if (mine !== seq.current) return;

      if (!mres.ok) {
        const payload = await mres.json().catch(() => ({}));
        toast.error(payload.error || t('loadMembersFailed'));
        return;
      }
      const mdata = (await mres.json()) as {
        members: RosterMember[];
        capabilityCounts?: Record<string, number>;
        capabilityTotal?: number;
      };
      setMembers(mdata.members);
      setCapabilityCounts(mdata.capabilityCounts ?? {});
      setCapabilityTotal(mdata.capabilityTotal ?? 0);

      if (tres.ok) {
        const tdata = (await tres.json()) as { teams: Team[] };
        setTeams(tdata.teams);
      } else {
        toast.error(t('loadTeamsFailed'));
      }

      if (ires) {
        if (ires.ok) {
          const idata = (await ires.json()) as {
            invitations: RosterInvitation[];
          };
          setInvitations(
            idata.invitations.map((i) => ({
              ...i,
              team_ids: Array.isArray(i.team_ids) ? i.team_ids : [],
            })),
          );
        } else {
          toast.error(t('loadInvitationsFailed'));
        }
      } else {
        setInvitations([]);
      }
    } catch (err) {
      console.error('[useTeamRoster] load error:', err);
      if (mine === seq.current) toast.error(t('networkError'));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [canInvite, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    members,
    teams,
    invitations,
    capabilityCounts,
    capabilityTotal,
    loading,
    reload,
  };
}
