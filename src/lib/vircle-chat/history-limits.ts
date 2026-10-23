// How far back Halo answers the Vircle Chat app's requests for older messages (docs/vircle-chat-contract.md, section 3.5; migration 193).
// Kept apart from history.ts, which reads the database, so the settings screen and the connection's types can use it too.

export const HISTORY_DAYS_DEFAULT = 90
export const HISTORY_DAYS_MIN = 1
export const HISTORY_DAYS_MAX = 365
