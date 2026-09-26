// ============================================================
// Team & Members: pure helpers shared by the Members view, the
// member panel, the invite dialog and their tests. No I/O, no React.
// ============================================================

import { roleRank, type AccountRole } from "@/lib/auth/roles";

/** A team as shown on a chip. */
export interface TeamRef {
  id: string;
  name: string;
  color: string;
}

/** One row of `list_team_members()` as the members route returns it. */
export interface RosterMember {
  user_id: string;
  full_name: string;
  /** Only Owner/Admin callers receive emails. */
  email: string | null;
  avatar_url: string | null;
  role: AccountRole;
  joined_at: string;
  /** From member_presence; null when never seen. */
  last_active: string | null;
  /** EVERY team the member belongs to. */
  teams: TeamRef[];
  open_conversations: number;
  open_tickets: number;
}

/** A pending invitation row as the invitations route returns it. */
export interface RosterInvitation {
  id: string;
  role: Exclude<AccountRole, "owner">;
  label: string | null;
  /** Migration 108. Set only for an email-targeted invite — null for a
   *  plain shareable-link invite, exactly like every row before it. */
  email: string | null;
  /** Migration 109. Set once a Resend invite email was actually sent
   *  for this row; null when no email was sent (no `email` set, Resend
   *  not configured, or the send failed). */
  email_sent_at: string | null;
  created_by_user_id: string | null;
  created_at: string;
  expires_at: string;
  team_ids: string[];
}

/** How many team chips show before the "+N" overflow. */
export const TEAM_CHIP_LIMIT = 4;

/**
 * Split a member's teams into the chips shown inline and the rest that
 * sit behind "+N" (the popover lists ALL of them).
 */
export function splitTeamChips<T>(
  teams: readonly T[],
  limit: number = TEAM_CHIP_LIMIT,
): { visible: T[]; overflow: number } {
  const max = Math.max(0, Math.floor(limit));
  if (teams.length <= max) return { visible: [...teams], overflow: 0 };
  return { visible: teams.slice(0, max), overflow: teams.length - max };
}

/** Roles a person may hand out: strictly below their own, never owner. */
export function rolesBelow(
  callerRole: AccountRole | null | undefined,
): Exclude<AccountRole, "owner">[] {
  if (!callerRole) return [];
  const all: Exclude<AccountRole, "owner">[] = ["admin", "agent", "viewer"];
  return all.filter((r) => roleRank(r) < roleRank(callerRole));
}

/**
 * May the caller change the role of / remove `member`? Never yourself,
 * never the Owner, never a role at or above your own. (The database
 * enforces the same in set_member_role / remove_account_member.)
 */
export function canActOnMember(
  callerRole: AccountRole | null | undefined,
  callerId: string | null | undefined,
  member: Pick<RosterMember, "user_id" | "role">,
): boolean {
  if (!callerRole) return false;
  if (member.user_id === callerId) return false;
  if (member.role === "owner") return false;
  return roleRank(member.role) < roleRank(callerRole);
}

export type MemberStatusFilter = "all" | "active" | "pending";

export interface RosterFilters {
  search: string;
  /** Match members on ANY of these teams. Empty = no team filter. */
  teamIds: string[];
  /** Match any of these roles. Empty = no role filter. */
  roles: AccountRole[];
  status: MemberStatusFilter;
}

export const EMPTY_FILTERS: RosterFilters = {
  search: "",
  teamIds: [],
  roles: [],
  status: "all",
};

/** True when any filter narrows the list. */
export function hasActiveFilters(f: RosterFilters): boolean {
  return (
    f.search.trim() !== "" ||
    f.teamIds.length > 0 ||
    f.roles.length > 0 ||
    f.status !== "all"
  );
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/** Display name with the email as a fallback (for search and sorting). */
export function memberLabel(m: Pick<RosterMember, "full_name" | "email">): string {
  return m.full_name.trim() || m.email || "";
}

export function filterMembers(
  members: readonly RosterMember[],
  f: RosterFilters,
): RosterMember[] {
  if (f.status === "pending") return [];
  const q = norm(f.search);
  return members.filter((m) => {
    if (f.roles.length > 0 && !f.roles.includes(m.role)) return false;
    if (
      f.teamIds.length > 0 &&
      !m.teams.some((t) => f.teamIds.includes(t.id))
    ) {
      return false;
    }
    if (q) {
      const hay = `${norm(m.full_name)} ${norm(m.email)}`;
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function filterInvitations(
  invitations: readonly RosterInvitation[],
  f: RosterFilters,
): RosterInvitation[] {
  if (f.status === "active") return [];
  const q = norm(f.search);
  return invitations.filter((inv) => {
    if (f.roles.length > 0 && !f.roles.includes(inv.role)) return false;
    if (
      f.teamIds.length > 0 &&
      !inv.team_ids.some((id) => f.teamIds.includes(id))
    ) {
      return false;
    }
    if (q && !norm(inv.label).includes(q) && !norm(inv.email).includes(q)) return false;
    return true;
  });
}

export type MemberSortKey = "name" | "role";
export type SortDir = "asc" | "desc";

/** Stable sort by name, or by role rank (highest first when asc). */
export function sortMembers(
  members: readonly RosterMember[],
  key: MemberSortKey,
  dir: SortDir = "asc",
): RosterMember[] {
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: RosterMember, b: RosterMember) =>
    memberLabel(a).localeCompare(memberLabel(b), undefined, {
      sensitivity: "base",
    });
  return [...members].sort((a, b) => {
    if (key === "role") {
      const diff = roleRank(b.role) - roleRank(a.role);
      if (diff !== 0) return sign * diff;
      return byName(a, b);
    }
    const diff = byName(a, b);
    return diff !== 0 ? sign * diff : a.user_id.localeCompare(b.user_id);
  });
}

/** Members of `teamId` from the roster (for the team panel and counts). */
export function membersOfTeam(
  members: readonly RosterMember[],
  teamId: string,
): RosterMember[] {
  return members.filter((m) => m.teams.some((t) => t.id === teamId));
}

/** Members who could still be added to `teamId`, filtered by a search. */
export function addableMembers(
  members: readonly RosterMember[],
  teamId: string,
  search = "",
): RosterMember[] {
  const q = norm(search);
  return members.filter((m) => {
    if (m.teams.some((t) => t.id === teamId)) return false;
    if (!q) return true;
    return `${norm(m.full_name)} ${norm(m.email)}`.includes(q);
  });
}

/** Diff between a member's current team ids and the wanted set. */
export function diffTeamIds(
  current: readonly string[],
  wanted: readonly string[],
): { add: string[]; remove: string[] } {
  const cur = new Set(current);
  const want = new Set(wanted);
  return {
    add: [...want].filter((id) => !cur.has(id)),
    remove: [...cur].filter((id) => !want.has(id)),
  };
}

/**
 * "3 hours ago" in the viewer's language. Null when the time is unknown.
 * Uses Intl so no English is hardcoded; `now` is injected so the label
 * advances with the caller's clock (and tests stay deterministic).
 */
export function relativeTime(
  iso: string | null | undefined,
  now: number,
  locale: string,
): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const mins = Math.floor(Math.max(0, now - then) / 60_000);
  if (mins < 1) return rtf.format(0, "minute");
  if (mins < 60) return rtf.format(-mins, "minute");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return rtf.format(-days, "day");
  const months = Math.floor(days / 30);
  if (months < 12) return rtf.format(-months, "month");
  return rtf.format(-Math.floor(days / 365), "year");
}
