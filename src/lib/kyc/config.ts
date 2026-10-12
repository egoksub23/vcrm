// ============================================================
// KYC review: the server-side configuration. Server only (reads process.env); never imported by a client component.
//
//   KYC_DOC_API_BASE_URL         https://apis-uat.vircle.com/verify_doc  (UAT)  or the production base URL
//   KYC_DOC_API_KEY              the x-api-key of the doc-processor back end (UAT_general-api-key / Prod_general-api-key)
//   KYC_DOC_ALLOWED_IMAGE_HOSTS  optional, comma separated: hosts the signed image URL may point to besides the back end's own domain
//                                (for example `*.s3.ap-southeast-1.amazonaws.com`)
//
// The key and the base URL exist ONLY here. They are never a NEXT_PUBLIC_ variable, never logged, never put in an error message or an audit row, and
// never returned by a route: `describeConfig` below is what a route may say about them (which variable names are missing, UAT or not), nothing more.
// ============================================================

export const ENV_BASE_URL = "KYC_DOC_API_BASE_URL";
export const ENV_API_KEY = "KYC_DOC_API_KEY";
export const ENV_ALLOWED_HOSTS = "KYC_DOC_ALLOWED_IMAGE_HOSTS";

export interface KycConfig {
  /** No trailing slash. */
  baseUrl: string;
  apiKey: string;
  /** The base URL's host (lower case). */
  baseHost: string;
  /** Extra hosts the signed image URL may use: exact names, or `*.suffix`. */
  allowedImageHosts: string[];
  /** The base URL looks like a test environment (UAT, staging, sandbox ...): the screen shows a banner. */
  uat: boolean;
}

export type ConfigResult = { ok: true; config: KycConfig } | { ok: false; missing: string[] };

type Env = Record<string, string | undefined>;

const UAT_HOST = /(^|[.-])(uat|staging|stg|sandbox|test|dev|qa)([.-]|$)/i;

/** Entries of the allow-list that are usable: a plain host name or `*.suffix`, lower case, no port, no path, no IP address. */
export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const h = part.trim().toLowerCase().replace(/\.$/, "");
    if (!h) continue;
    if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) continue;
    if (/^(\*\.)?\d+(\.\d+){3}$/.test(h)) continue;
    out.push(h);
  }
  return out;
}

/**
 * Read the configuration. `missing` names the VARIABLES that are absent or unusable (never their values), so an administrator can be told what to set.
 * The base URL must be https, with no credentials, query or fragment.
 */
export function readKycConfig(env: Env = process.env): ConfigResult {
  const missing: string[] = [];
  const rawBase = (env[ENV_BASE_URL] ?? "").trim();
  const apiKey = (env[ENV_API_KEY] ?? "").trim();

  let baseUrl = "";
  let baseHost = "";
  if (rawBase) {
    try {
      const u = new URL(rawBase);
      if (u.protocol === "https:" && u.hostname && !u.username && !u.password && !u.search && !u.hash) {
        baseUrl = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
        baseHost = u.hostname.toLowerCase();
      }
    } catch {
      // unusable: reported below
    }
  }
  if (!baseUrl) missing.push(ENV_BASE_URL);
  if (!apiKey) missing.push(ENV_API_KEY);
  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    config: { baseUrl, apiKey, baseHost, allowedImageHosts: parseAllowedHosts(env[ENV_ALLOWED_HOSTS]), uat: UAT_HOST.test(baseHost) },
  };
}

/** What a route may say about the configuration. Never the key, never the base URL. */
export function describeConfig(result: ConfigResult): { configured: boolean; uat: boolean; missing: string[] } {
  return result.ok ? { configured: true, uat: result.config.uat, missing: [] } : { configured: false, uat: false, missing: result.missing };
}

/** Remove the key (and the base URL) from any text before it is logged or thrown. Defence in depth: no code path is meant to put them there. */
export function redact(text: string, config: Pick<KycConfig, "apiKey" | "baseUrl"> | null): string {
  let out = text;
  if (config?.apiKey) out = out.split(config.apiKey).join("[redacted]");
  if (config?.baseUrl) out = out.split(config.baseUrl).join("[redacted-url]");
  return out;
}
