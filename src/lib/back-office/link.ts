// ============================================================
// The "Open in Vircle Back Office" link (Inbox).
//
// A customer care agent in a conversation with a parent can open that parent's record in the
// Vircle Back Office (BO2). The address of the Back Office is configuration (BACK_OFFICE_USER_URL,
// read on the server by /api/account/back-office-link); the link for ONE contact is built here, in
// the browser, so the phone number never goes to Halo's server.
//
// Rules from the Back Office team:
//   - the phone goes after #q= and NOT ?q=. A fragment is never sent to a server, so the number stays
//     out of server logs and the Referer header; BO2 reads it and wipes it from the address bar
//   - the value is URL-encoded (a leading + becomes %2B)
//   - either format works (+60123456789 or 0123456789): the number is sent AS HELD, never normalised
//   - no name is passed: the phone is the reliable key
//
// Pure and free of Node-only imports: the Inbox (a client component) imports this file.
// ============================================================

/**
 * Reads the configured address of the Back Office page: an https URL, with any query string or
 * fragment removed. Returns null for anything else (unset, blank, not a URL, http, a URL with a
 * user name or password in it), which hides the feature.
 */
export function parseBackOfficeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  if (url.username || url.password) return null;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * BACK_OFFICE_EMBED: "true" or "1" (any case, spaces ignored) shows the Back Office inside the Inbox panel; anything else,
 * including unset, opens it in a new tab. Off by default.
 */
export function parseBackOfficeEmbed(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const text = raw.trim().toLowerCase();
  return text === "true" || text === "1";
}

/**
 * The link that opens a contact's record in the Back Office: `<base>#q=<encoded phone>`, or null
 * when there is nothing to open (no usable address, no phone number).
 *
 * The phone is trimmed and otherwise left exactly as Halo holds it (no lower-casing, no
 * normalising, no country code added). The base is checked again here (https only, query and
 * fragment removed) so a wrong value can never produce a link.
 */
export function buildBackOfficeUrl(baseUrl: string | null | undefined, phone: string | null | undefined): string | null {
  const base = parseBackOfficeBaseUrl(baseUrl);
  if (!base) return null;
  if (typeof phone !== "string") return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;
  try {
    return `${base}#q=${encodeURIComponent(trimmed)}`;
  } catch {
    // encodeURIComponent throws on a lone surrogate half; such a value is not a phone number.
    return null;
  }
}
