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
import type { AddonRoleEntry } from '@/lib/auth/addon-roles';
import type { AssignableAddonRole, AssignableCustomRole, RosterInvitation, RosterMember } from '@/lib/teams/members';
import type { Team } from '@/types';

export interface TeamRoster {
  members: RosterMember[];
  teams: Team[];
  invitations: RosterInvitation[];
  /** Capabilities enabled per role (for the access summary). */
  capabilityCounts: Record<string, number>;
  /** Same, per custom role id — a member's real count when they hold one. */
  customRoleCapabilityCounts: Record<string, number>;
  capabilityTotal: number;
  /** For a member who holds add-on roles, how many permissions they really have (the base role's plus the add-ons'), by user id. */
  effectiveCapabilityCounts: Record<string, number>;
  /** The workspace's add-on roles (migration 191), for the member panel and the invite dialog. Empty for someone who can do neither. */
  addonRoles: AssignableAddonRole[];
  /** The account's custom roles, for the role picker. Empty for a
   *  caller who cannot see them (fetch requires roles.manage) — the
   *  picker then just offers the 4 built-ins, same as before this
   *  feature existed. */
  customRoles: AssignableCustomRole[];
  loading: boolean;
  reload: () => Promise<void>;
}

export function useTeamRoster(): TeamRoster {
  const t = useTranslations('Settings.team');
  const canInvite = useCapability('members.invite');
  const canSeeRoles = useCapability('roles.manage');
  const canChangeRole = useCapability('members.change-role');
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [invitations, setInvitations] = useState<RosterInvitation[]>([]);
  const [capabilityCounts, setCapabilityCounts] = useState<
    Record<string, number>
  >({});
  const [customRoleCapabilityCounts, setCustomRoleCapabilityCounts] = useState<
    Record<string, number>
  >({});
  const [capabilityTotal, setCapabilityTotal] = useState(0);
  const [effectiveCapabilityCounts, setEffectiveCapabilityCounts] = useState<Record<string, number>>({});
  const [addonRoles, setAddonRoles] = useState<AssignableAddonRole[]>([]);
  const [customRoles, setCustomRoles] = useState<AssignableCustomRole[]>([]);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [mres, tres, ires, cres, ares] = await Promise.all([
        fetch('/api/account/members', { cache: 'no-store' }),
        fetch('/api/account/teams', { cache: 'no-store' }),
        canInvite
          ? fetch('/api/account/invitations', { cache: 'no-store' })
          : Promise.resolve(null),
        canSeeRoles
          ? fetch('/api/account/roles/custom', { cache: 'no-store' })
          : Promise.resolve(null),
        canChangeRole || canInvite
          ? fetch('/api/account/roles/addons', { cache: 'no-store' })
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
        customRoleCapabilityCounts?: Record<string, number>;
        effectiveCapabilityCounts?: Record<string, number>;
        capabilityTotal?: number;
      };
      setMembers(mdata.members);
      setEffectiveCapabilityCounts(mdata.effectiveCapabilityCounts ?? {});
      setCapabilityCounts(mdata.capabilityCounts ?? {});
      setCustomRoleCapabilityCounts(mdata.customRoleCapabilityCounts ?? {});
      setCapabilityTotal(mdata.capabilityTotal ?? 0);

      if (cres?.ok) {
        const cdata = (await cres.json()) as {
          roles: { id: string; name: string; baseRole: AssignableCustomRole['baseRole'] }[];
        };
        setCustomRoles(cdata.roles.map((r) => ({ id: r.id, name: r.name, baseRole: r.baseRole })));
      } else if (cres) {
        setCustomRoles([]);
      }

      if (ares?.ok) {
        const adata = (await ares.json()) as { addons: AddonRoleEntry[] };
        setAddonRoles(adata.addons.map((a) => ({ id: a.id, name: a.name, description: a.description, minBaseRole: a.minBaseRole })));
      } else if (ares) {
        setAddonRoles([]);
      }

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
  }, [canInvite, canSeeRoles, canChangeRole, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    members,
    teams,
    invitations,
    capabilityCounts,
    customRoleCapabilityCounts,
    capabilityTotal,
    effectiveCapabilityCounts,
    addonRoles,
    customRoles,
    loading,
    reload,
  };
}
