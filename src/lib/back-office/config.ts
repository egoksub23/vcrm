import { parseBackOfficeBaseUrl, parseBackOfficeEmbed } from "./link";

type Env = Record<string, string | undefined>;

/**
 * The Back Office address this deployment is configured with (BACK_OFFICE_USER_URL), or null when
 * it is unset or not a valid https URL (the Inbox then shows no Back Office action at all).
 *
 * Server side only. Read from the environment at call time, never at import time, so changing the
 * variable and restarting the container needs no rebuild.
 */
export function getBackOfficeBaseUrl(env: Env = process.env): string | null {
  return parseBackOfficeBaseUrl(env["BACK_OFFICE_USER_URL"]);
}

/** Whether the Back Office is shown inside the Inbox (BACK_OFFICE_EMBED true or 1). Off by default, and off whenever there is no valid address. */
export function getBackOfficeEmbed(env: Env = process.env): boolean {
  return getBackOfficeBaseUrl(env) !== null && parseBackOfficeEmbed(env["BACK_OFFICE_EMBED"]);
}
