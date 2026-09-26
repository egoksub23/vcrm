import { describe, expect, it } from "vitest";

import {
  EMPTY_FILTERS,
  addableMembers,
  canActOnMember,
  diffTeamIds,
  filterInvitations,
  filterMembers,
  hasActiveFilters,
  membersOfTeam,
  relativeTime,
  rolesBelow,
  sortMembers,
  splitTeamChips,
  type RosterInvitation,
  type RosterMember,
} from "./members";

const team = (id: string, name = id) => ({ id, name, color: "#000000" });

function member(over: Partial<RosterMember> & { user_id: string }): RosterMember {
  return {
    full_name: over.user_id,
    email: null,
    avatar_url: null,
    role: "agent",
    joined_at: "2026-01-01T00:00:00Z",
    last_active: null,
    teams: [],
    open_conversations: 0,
    open_tickets: 0,
    ...over,
  };
}

describe("splitTeamChips", () => {
  it("shows everything up to the limit with no overflow", () => {
    const teams = [team("a"), team("b"), team("c"), team("d")];
    expect(splitTeamChips(teams)).toEqual({ visible: teams, overflow: 0 });
  });

  it("shows the first four and counts the rest", () => {
    const teams = ["a", "b", "c", "d", "e", "f"].map((id) => team(id));
    const { visible, overflow } = splitTeamChips(teams);
    expect(visible.map((t) => t.id)).toEqual(["a", "b", "c", "d"]);
    expect(overflow).toBe(2);
  });

  it("handles no teams, and a custom or odd limit", () => {
    expect(splitTeamChips([])).toEqual({ visible: [], overflow: 0 });
    expect(splitTeamChips([1, 2, 3], 1)).toEqual({ visible: [1], overflow: 2 });
    expect(splitTeamChips([1, 2], 0)).toEqual({ visible: [], overflow: 2 });
    expect(splitTeamChips([1, 2], -3)).toEqual({ visible: [], overflow: 2 });
  });

  it("does not mutate its input", () => {
    const teams = [team("a"), team("b")];
    splitTeamChips(teams, 1);
    expect(teams).toHaveLength(2);
  });
});

describe("rolesBelow (the invite and change-role dropdowns)", () => {
  it("offers an Owner admin, agent and viewer", () => {
    expect(rolesBelow("owner")).toEqual(["admin", "agent", "viewer"]);
  });
  it("offers an Admin only agent and viewer", () => {
    expect(rolesBelow("admin")).toEqual(["agent", "viewer"]);
  });
  it("offers an Agent only a viewer, a Viewer nothing", () => {
    expect(rolesBelow("agent")).toEqual(["viewer"]);
    expect(rolesBelow("viewer")).toEqual([]);
  });
  it("offers nothing without a role, and never the owner role", () => {
    expect(rolesBelow(null)).toEqual([]);
    expect(rolesBelow(undefined)).toEqual([]);
    expect(rolesBelow("owner")).not.toContain("owner");
  });
});

describe("canActOnMember", () => {
  const admin = member({ user_id: "admin", role: "admin" });
  const agent = member({ user_id: "agent", role: "agent" });
  const owner = member({ user_id: "owner", role: "owner" });

  it("lets an Owner act on an Admin, an Admin only on an Agent", () => {
    expect(canActOnMember("owner", "o", admin)).toBe(true);
    expect(canActOnMember("admin", "a", agent)).toBe(true);
    expect(canActOnMember("admin", "a", admin)).toBe(false);
  });
  it("never lets anyone act on the Owner or on themselves", () => {
    expect(canActOnMember("owner", "x", owner)).toBe(false);
    expect(canActOnMember("admin", "x", owner)).toBe(false);
    expect(canActOnMember("owner", "agent", agent)).toBe(false);
  });
  it("fails closed without a role", () => {
    expect(canActOnMember(null, "a", agent)).toBe(false);
  });
});

describe("filterMembers", () => {
  const ana = member({
    user_id: "1",
    full_name: "Ana Lima",
    email: "ana@example.com",
    role: "admin",
    teams: [team("tech"), team("billing")],
  });
  const ben = member({
    user_id: "2",
    full_name: "Ben Ito",
    email: "ben@corp.io",
    role: "agent",
    teams: [team("billing")],
  });
  const cy = member({ user_id: "3", full_name: "Cy", role: "viewer", teams: [] });
  const all = [ana, ben, cy];

  it("returns everyone with no filters", () => {
    expect(filterMembers(all, EMPTY_FILTERS)).toEqual(all);
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  it("matches members on ANY selected team (multi-team members match either)", () => {
    const r = filterMembers(all, { ...EMPTY_FILTERS, teamIds: ["tech"] });
    expect(r.map((m) => m.user_id)).toEqual(["1"]);
    const both = filterMembers(all, { ...EMPTY_FILTERS, teamIds: ["tech", "billing"] });
    expect(both.map((m) => m.user_id)).toEqual(["1", "2"]);
  });

  it("filters by role", () => {
    const r = filterMembers(all, { ...EMPTY_FILTERS, roles: ["agent", "viewer"] });
    expect(r.map((m) => m.user_id)).toEqual(["2", "3"]);
  });

  it("searches name and email, case-insensitively", () => {
    expect(filterMembers(all, { ...EMPTY_FILTERS, search: "  ANA " }).map((m) => m.user_id)).toEqual(["1"]);
    expect(filterMembers(all, { ...EMPTY_FILTERS, search: "corp.io" }).map((m) => m.user_id)).toEqual(["2"]);
    expect(filterMembers(all, { ...EMPTY_FILTERS, search: "nobody" })).toEqual([]);
  });

  it("combines filters with AND", () => {
    const r = filterMembers(all, { ...EMPTY_FILTERS, teamIds: ["billing"], roles: ["agent"] });
    expect(r.map((m) => m.user_id)).toEqual(["2"]);
  });

  it("hides every member when only pending invitations are wanted", () => {
    expect(filterMembers(all, { ...EMPTY_FILTERS, status: "pending" })).toEqual([]);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, status: "pending" })).toBe(true);
  });
});

describe("filterInvitations", () => {
  const inv = (over: Partial<RosterInvitation> & { id: string }): RosterInvitation => ({
    role: "agent",
    label: null,
    email: null,
    email_sent_at: null,
    created_by_user_id: null,
    created_at: "2026-01-01T00:00:00Z",
    expires_at: "2026-02-01T00:00:00Z",
    team_ids: [],
    ...over,
  });
  const list = [
    inv({ id: "a", label: "Sara from support", team_ids: ["tech"] }),
    inv({ id: "b", role: "viewer", label: "Tom" }),
    inv({ id: "c", role: "viewer", label: null, email: "priya@example.com" }),
  ];

  it("filters by team, role and label, and hides them for active-only", () => {
    expect(filterInvitations(list, EMPTY_FILTERS)).toHaveLength(3);
    expect(filterInvitations(list, { ...EMPTY_FILTERS, teamIds: ["tech"] }).map((i) => i.id)).toEqual(["a"]);
    expect(filterInvitations(list, { ...EMPTY_FILTERS, roles: ["viewer"] }).map((i) => i.id)).toEqual(["b", "c"]);
    expect(filterInvitations(list, { ...EMPTY_FILTERS, search: "sara" }).map((i) => i.id)).toEqual(["a"]);
    expect(filterInvitations(list, { ...EMPTY_FILTERS, status: "active" })).toEqual([]);
  });

  it("also matches an email-targeted invite's email (migration 108)", () => {
    expect(filterInvitations(list, { ...EMPTY_FILTERS, search: "priya" }).map((i) => i.id)).toEqual(["c"]);
    expect(filterInvitations(list, { ...EMPTY_FILTERS, search: "PRIYA@EXAMPLE.COM" }).map((i) => i.id)).toEqual(["c"]);
  });
});

describe("sortMembers", () => {
  const list = [
    member({ user_id: "1", full_name: "zoe", role: "viewer" }),
    member({ user_id: "2", full_name: "Amy", role: "agent" }),
    member({ user_id: "3", full_name: "bob", role: "admin" }),
    member({ user_id: "4", full_name: "", email: "carl@x.io", role: "agent" }),
    member({ user_id: "5", full_name: "Owen", role: "owner" }),
  ];

  it("sorts by name ignoring case, falling back to email", () => {
    expect(sortMembers(list, "name").map((m) => m.user_id)).toEqual(["2", "3", "4", "5", "1"]);
    expect(sortMembers(list, "name", "desc").map((m) => m.user_id)).toEqual(["1", "5", "4", "3", "2"]);
  });

  it("sorts by role, highest first, ties by name", () => {
    expect(sortMembers(list, "role").map((m) => m.user_id)).toEqual(["5", "3", "2", "4", "1"]);
    expect(sortMembers(list, "role", "desc").map((m) => m.user_id)).toEqual(["1", "2", "4", "3", "5"]);
  });

  it("does not mutate its input", () => {
    const copy = [...list];
    sortMembers(list, "name");
    expect(list).toEqual(copy);
  });
});

describe("team panel helpers", () => {
  const list = [
    member({ user_id: "1", full_name: "Ana", teams: [team("t1"), team("t2")] }),
    member({ user_id: "2", full_name: "Ben", email: "ben@x.io", teams: [team("t2")] }),
    member({ user_id: "3", full_name: "Cy" }),
  ];

  it("lists a team's members from the roster", () => {
    expect(membersOfTeam(list, "t2").map((m) => m.user_id)).toEqual(["1", "2"]);
    expect(membersOfTeam(list, "t9")).toEqual([]);
  });

  it("offers only people not on the team, narrowed by search", () => {
    expect(addableMembers(list, "t1").map((m) => m.user_id)).toEqual(["2", "3"]);
    expect(addableMembers(list, "t1", "ben@").map((m) => m.user_id)).toEqual(["2"]);
    expect(addableMembers(list, "t2", "").map((m) => m.user_id)).toEqual(["3"]);
  });

  it("diffs a member's team set", () => {
    expect(diffTeamIds(["a", "b"], ["b", "c"])).toEqual({ add: ["c"], remove: ["a"] });
    expect(diffTeamIds([], [])).toEqual({ add: [], remove: [] });
    expect(diffTeamIds(["a"], ["a", "a"])).toEqual({ add: [], remove: [] });
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-09-20T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("is null when the time is unknown or invalid", () => {
    expect(relativeTime(null, now, "en")).toBeNull();
    expect(relativeTime(undefined, now, "en")).toBeNull();
    expect(relativeTime("garbage", now, "en")).toBeNull();
  });

  it("picks the largest sensible unit", () => {
    expect(relativeTime(ago(30_000), now, "en")).toBe("this minute");
    expect(relativeTime(ago(5 * 60_000), now, "en")).toBe("5 minutes ago");
    expect(relativeTime(ago(3 * 3_600_000), now, "en")).toBe("3 hours ago");
    expect(relativeTime(ago(2 * 86_400_000), now, "en")).toBe("2 days ago");
    expect(relativeTime(ago(65 * 86_400_000), now, "en")).toBe("2 months ago");
  });

  it("follows the requested language", () => {
    expect(relativeTime(ago(3 * 3_600_000), now, "ko")).toBe("3시간 전");
  });
});
