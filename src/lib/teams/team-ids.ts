// ============================================================
// Validation for lists of team / user ids that arrive in request
// bodies (invitation teams, a member's team set, bulk team changes).
// Shape checks only: the database decides which ids actually belong to
// the caller's account and silently ignores the rest.
// ============================================================

export const MAX_TEAM_IDS = 50;
export const MAX_BULK_USER_IDS = 200;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export type IdListResult =
  | { ok: true; ids: string[] }
  | { ok: false; error: string };

/**
 * `undefined`/`null` -> [] (the field is optional). Otherwise it must be
 * an array of uuid strings, at most `max` after de-duplication.
 */
export function parseUuidList(
  raw: unknown,
  label: string,
  max: number = MAX_TEAM_IDS,
): IdListResult {
  if (raw === undefined || raw === null) return { ok: true, ids: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: `'${label}' must be an array of ids` };
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (!isUuid(v)) {
      return { ok: false, error: `'${label}' must contain only valid ids` };
    }
    const key = v.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      ids.push(key);
    }
  }
  if (ids.length > max) {
    return { ok: false, error: `'${label}' can hold at most ${max} ids` };
  }
  return { ok: true, ids };
}

/** Teams an invitation adds the new member to (optional, may be empty). */
export function parseInviteTeamIds(raw: unknown): IdListResult {
  return parseUuidList(raw, "teamIds", MAX_TEAM_IDS);
}

export type BulkTeamChange =
  | {
      ok: true;
      action: "add" | "remove";
      userIds: string[];
      teamIds: string[];
    }
  | { ok: false; error: string };

/** Body of a bulk "add to team / remove from team" request. */
export function parseBulkTeamChange(body: unknown): BulkTeamChange {
  const b = (body ?? {}) as {
    action?: unknown;
    user_ids?: unknown;
    team_ids?: unknown;
  };
  if (b.action !== "add" && b.action !== "remove") {
    return { ok: false, error: "'action' must be 'add' or 'remove'" };
  }
  const users = parseUuidList(b.user_ids, "user_ids", MAX_BULK_USER_IDS);
  if (!users.ok) return users;
  const teams = parseUuidList(b.team_ids, "team_ids", MAX_TEAM_IDS);
  if (!teams.ok) return teams;
  if (users.ids.length === 0 || teams.ids.length === 0) {
    return { ok: false, error: "Pick at least one member and one team" };
  }
  return {
    ok: true,
    action: b.action,
    userIds: users.ids,
    teamIds: teams.ids,
  };
}
