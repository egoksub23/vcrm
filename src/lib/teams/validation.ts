// ============================================================
// Shared team field validation — used by both the create (POST
// /api/account/teams) and update (PATCH /api/account/teams/[id])
// routes so the limits can't drift between them.
// ============================================================

export const TEAM_NAME_MAX_LEN = 60;
export const TEAM_DESCRIPTION_MAX_LEN = 240;
export const TEAM_DEFAULT_COLOR = "#6366f1";
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export interface FieldError {
  error: string;
}

/** Trims and validates a required team name. Returns the error message, or null if valid. */
export function validateTeamName(name: string): string | null {
  if (!name) return "Team name is required";
  if (name.length > TEAM_NAME_MAX_LEN) {
    return `Team name must be ${TEAM_NAME_MAX_LEN} characters or fewer`;
  }
  return null;
}

/** Validates an optional team description. Returns the error message, or null if valid. */
export function validateTeamDescription(description: string): string | null {
  if (description.length > TEAM_DESCRIPTION_MAX_LEN) {
    return `Description must be ${TEAM_DESCRIPTION_MAX_LEN} characters or fewer`;
  }
  return null;
}
