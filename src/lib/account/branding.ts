// ============================================================
// Validation for PATCH /api/account: the workspace's own name plus the
// per-tenant branding of migration 133 (product name and logo shown in the
// app chrome). Pure; unit-tested in branding.test.ts.
//
// The database re-checks the same bounds (accounts_brand_name_check /
// accounts_brand_logo_url_check); this gives a clear 400 first.
// ============================================================

import { normalizeLocale } from "@/lib/i18n/locales";

export const MAX_ACCOUNT_NAME_LEN = 80;
export const MAX_BRAND_NAME_LEN = 60;
export const MAX_LOGO_URL_LEN = 500;
export const MAX_EMAIL_SENDER_NAME_LEN = 60;
export const MAX_EMAIL_LEN = 254;
export const MAX_TIMEZONE_LEN = 64;

/** Characters that could break out of a mail header (mirrors accounts_email_sender_name_check). */
const UNSAFE_SENDER_NAME = /[\r\n"<>;,]/;
/** One plain address, no display name or list (mirrors accounts_email_reply_to_check). */
const PLAIN_EMAIL = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;

export interface AccountPatch {
  name?: string;
  /** null clears it (back to the neutral product default). */
  brand_name?: string | null;
  brand_logo_url?: string | null;
  /** Display name on the workspace's outgoing mail (migration 143). null = fall back to the brand name. */
  email_sender_name?: string | null;
  /** Where replies to the workspace's outgoing mail go (migration 143). */
  email_reply_to?: string | null;
  /** The workspace's language (migration 144). null = follow the deployment default. */
  locale?: string | null;
  /** The workspace's IANA timezone (migration 144). Never null. */
  timezone?: string;
}

type Result = { ok: true; value: AccountPatch } | { ok: false; error: string };

export function parseAccountPatch(body: unknown): Result {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Invalid request body" };
  }
  const b = body as Record<string, unknown>;
  const out: AccountPatch = {};

  if (b.name !== undefined) {
    if (typeof b.name !== "string") return { ok: false, error: "'name' must be a string" };
    const name = b.name.trim();
    if (name.length === 0) return { ok: false, error: "Account name cannot be empty" };
    if (name.length > MAX_ACCOUNT_NAME_LEN) {
      return { ok: false, error: `Account name must be ${MAX_ACCOUNT_NAME_LEN} characters or fewer` };
    }
    out.name = name;
  }

  if (b.brand_name !== undefined) {
    if (b.brand_name === null) {
      out.brand_name = null;
    } else if (typeof b.brand_name === "string") {
      const v = b.brand_name.trim();
      if (v.length > MAX_BRAND_NAME_LEN) {
        return { ok: false, error: `Product name must be ${MAX_BRAND_NAME_LEN} characters or fewer` };
      }
      out.brand_name = v === "" ? null : v;
    } else {
      return { ok: false, error: "'brand_name' must be a string or null" };
    }
  }

  if (b.brand_logo_url !== undefined) {
    if (b.brand_logo_url === null) {
      out.brand_logo_url = null;
    } else if (typeof b.brand_logo_url === "string") {
      const v = b.brand_logo_url.trim();
      if (v === "") {
        out.brand_logo_url = null;
      } else {
        if (v.length > MAX_LOGO_URL_LEN) {
          return { ok: false, error: `Logo URL must be ${MAX_LOGO_URL_LEN} characters or fewer` };
        }
        let url: URL;
        try {
          url = new URL(v);
        } catch {
          return { ok: false, error: "Logo URL is not a valid URL" };
        }
        if (url.protocol !== "https:") {
          return { ok: false, error: "Logo URL must start with https://" };
        }
        out.brand_logo_url = v;
      }
    } else {
      return { ok: false, error: "'brand_logo_url' must be a string or null" };
    }
  }

  if (b.email_sender_name !== undefined) {
    if (b.email_sender_name === null) {
      out.email_sender_name = null;
    } else if (typeof b.email_sender_name === "string") {
      const v = b.email_sender_name.trim();
      if (v.length > MAX_EMAIL_SENDER_NAME_LEN) {
        return { ok: false, error: `Sender name must be ${MAX_EMAIL_SENDER_NAME_LEN} characters or fewer` };
      }
      if (UNSAFE_SENDER_NAME.test(v)) {
        return { ok: false, error: "Sender name cannot contain quotes, angle brackets, commas or semicolons" };
      }
      out.email_sender_name = v === "" ? null : v;
    } else {
      return { ok: false, error: "'email_sender_name' must be a string or null" };
    }
  }

  if (b.email_reply_to !== undefined) {
    if (b.email_reply_to === null) {
      out.email_reply_to = null;
    } else if (typeof b.email_reply_to === "string") {
      const v = b.email_reply_to.trim();
      if (v === "") {
        out.email_reply_to = null;
      } else if (v.length > MAX_EMAIL_LEN || !PLAIN_EMAIL.test(v)) {
        return { ok: false, error: "Reply-to must be a single email address" };
      } else {
        out.email_reply_to = v;
      }
    } else {
      return { ok: false, error: "'email_reply_to' must be a string or null" };
    }
  }

  if (b.locale !== undefined) {
    if (b.locale === null || b.locale === "") {
      out.locale = null;
    } else if (typeof b.locale === "string") {
      const code = normalizeLocale(b.locale);
      if (!code) return { ok: false, error: "That language is not available" };
      out.locale = code;
    } else {
      return { ok: false, error: "'locale' must be a string or null" };
    }
  }

  if (b.timezone !== undefined) {
    if (typeof b.timezone !== "string" || b.timezone.trim() === "") {
      return { ok: false, error: "'timezone' must be a timezone name" };
    }
    const tz = b.timezone.trim();
    // The database checks the name against its own list; this keeps junk out first.
    if (tz.length > MAX_TIMEZONE_LEN || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) {
      return { ok: false, error: "That is not a timezone name" };
    }
    out.timezone = tz;
  }

  if (Object.keys(out).length === 0) return { ok: false, error: "Nothing to update" };
  return { ok: true, value: out };
}
