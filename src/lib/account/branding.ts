// ============================================================
// Validation for PATCH /api/account: the workspace's own name plus the
// per-tenant branding of migration 133 (product name and logo shown in the
// app chrome). Pure; unit-tested in branding.test.ts.
//
// The database re-checks the same bounds (accounts_brand_name_check /
// accounts_brand_logo_url_check); this gives a clear 400 first.
// ============================================================

export const MAX_ACCOUNT_NAME_LEN = 80;
export const MAX_BRAND_NAME_LEN = 60;
export const MAX_LOGO_URL_LEN = 500;

export interface AccountPatch {
  name?: string;
  /** null clears it (back to the neutral product default). */
  brand_name?: string | null;
  brand_logo_url?: string | null;
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

  if (Object.keys(out).length === 0) return { ok: false, error: "Nothing to update" };
  return { ok: true, value: out };
}
