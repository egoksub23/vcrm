// ============================================================
// KYC review: the guard for the signed image URL. Server only.
//
// The back end answers GET /validations/{id}/url with a URL, and Halo then fetches that URL from the server. A URL that came from another system
// is not trusted: a wrong or hostile answer must not make the Halo server call something inside the network. A URL is allowed only when ALL hold:
//   * https, no credentials, port 443, a plain DNS name (an IP address, in any notation, is refused: nothing legitimate needs one)
//   * not localhost, .local, .internal, .localdomain or a name without a dot
//   * the host is in the same registrable domain as the back end's base URL, or matches KYC_DOC_ALLOWED_IMAGE_HOSTS
// This function checks the text. The fetch itself goes through lib/net/safe-fetch (pinnedFetch), which refuses a connection to a private, loopback or
// link-local address whatever the name resolves to (DNS rebinding), and never follows a redirect.
// ============================================================

import { isIP } from "node:net";

import { isPrivateOrReservedIp } from "@/lib/webhooks/ssrf";

export type ImageUrlCheck = { ok: true; url: URL } | { ok: false; reason: "invalid" | "not_https" | "credentials" | "port" | "ip_literal" | "internal_name" | "host_not_allowed" };

const MAX_URL_CHARS = 4096;

// Second-level labels under a two-letter country code (co.uk, com.my ...): the registrable domain then has three labels. Approximate on purpose
// (no public-suffix list is shipped); KYC_DOC_ALLOWED_IMAGE_HOSTS is the precise tool.
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go"]);

// Domains that many unrelated parties share: being "on the same domain" proves nothing there, so a back end hosted on one of them gets no
// same-domain allowance and must name the image hosts in KYC_DOC_ALLOWED_IMAGE_HOSTS.
const SHARED_DOMAINS = new Set([
  "amazonaws.com", "cloudfront.net", "azurewebsites.net", "windows.net", "cloudapp.net", "herokuapp.com", "vercel.app", "netlify.app", "github.io",
  "googleapis.com", "appspot.com", "run.app", "ondigitalocean.app", "pages.dev", "workers.dev", "ngrok.io", "ngrok-free.app", "trycloudflare.com",
  "web.app", "firebaseapp.com", "onrender.com", "fly.dev", "railway.app",
]);

/** `a.b.vircle.com` -> `vircle.com`; `x.vircle.com.my` -> `vircle.com.my`. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const last = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const take = last.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** Does `host` match an allow-list entry: an exact name, or `*.suffix` (any subdomain, not the suffix itself)? */
export function matchesAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((entry) => {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".example.com"
      return h.length > suffix.length && h.endsWith(suffix);
    }
    return h === entry;
  });
}

export function checkImageUrl(raw: string, baseHost: string, allowedHosts: readonly string[]): ImageUrlCheck {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_CHARS) return { ok: false, reason: "invalid" };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (url.port !== "" && url.port !== "443") return { ok: false, reason: "port" };

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^\[|\]$/g, "");
  // Any IP literal (the URL parser has already turned 0x7f.1, 2130706433 and the like into dotted form) and any name that is really a number.
  if (isIP(bare) !== 0 || isPrivateOrReservedIp(bare) || /^[0-9.]+$/.test(bare)) return { ok: false, reason: "ip_literal" };
  if (!host.includes(".") || host === "localhost" || /\.(localhost|local|internal|localdomain|lan|home|corp|intranet)$/.test(host)) {
    return { ok: false, reason: "internal_name" };
  }
  if (!/^[a-z0-9.-]+$/.test(host)) return { ok: false, reason: "invalid" };

  const baseDomain = registrableDomain(baseHost);
  const sameDomain = baseHost !== "" && !SHARED_DOMAINS.has(baseDomain) && registrableDomain(host) === baseDomain;
  if (!sameDomain && !matchesAllowed(host, allowedHosts)) return { ok: false, reason: "host_not_allowed" };
  return { ok: true, url };
}
