// ============================================================
// Request-body validation for the operator console routes
// (/api/platform/accounts). Pure; unit-tested in validate.test.ts.
// ============================================================
import { PLATFORM_FEATURES, PLATFORM_LIMITS } from "./features";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_NAME = 120;
const MAX_PLAN = 40;
const MAX_REASON = 500;
const MAX_SEATS = 100_000;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const MAX_ADMIN_EMAILS = 10;

export interface CreateTenantInput {
  companyName: string;
  legalName: string | null;
  ownerEmail: string;
  ownerName: string | null;
  adminEmails: string[];
  plan: string | null;
  seats: number | null;
  features: Record<string, boolean> | null;
}

export function parseCreateTenant(body: unknown): Result<CreateTenantInput> {
  if (!isObject(body)) return { ok: false, error: "Invalid request body" };

  const companyName = typeof body.companyName === "string" ? body.companyName.trim() : "";
  if (!companyName || companyName.length > MAX_NAME) {
    return { ok: false, error: `'companyName' is required (max ${MAX_NAME} characters)` };
  }

  let legalName: string | null = null;
  if (body.legalName !== undefined && body.legalName !== null && body.legalName !== "") {
    if (typeof body.legalName !== "string" || body.legalName.trim().length > MAX_NAME) {
      return { ok: false, error: `'legalName' must be at most ${MAX_NAME} characters` };
    }
    legalName = body.legalName.trim() || null;
  }

  const ownerEmail =
    typeof body.ownerEmail === "string" ? body.ownerEmail.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(ownerEmail)) {
    return { ok: false, error: "'ownerEmail' must be a valid email address" };
  }

  let ownerName: string | null = null;
  if (body.ownerName !== undefined && body.ownerName !== null && body.ownerName !== "") {
    if (typeof body.ownerName !== "string" || body.ownerName.trim().length > MAX_NAME) {
      return { ok: false, error: `'ownerName' must be at most ${MAX_NAME} characters` };
    }
    ownerName = body.ownerName.trim() || null;
  }

  // Additional admin emails (comma or newline separated string, or array)
  const adminEmails: string[] = [];
  const rawAdmins = body.adminEmails;
  if (rawAdmins !== undefined && rawAdmins !== null && rawAdmins !== "") {
    const list = Array.isArray(rawAdmins)
      ? (rawAdmins as unknown[]).map((e) => String(e))
      : typeof rawAdmins === "string"
        ? rawAdmins.split(/[\n,]+/)
        : [];
    for (const raw of list) {
      const e = raw.trim().toLowerCase();
      if (!e) continue;
      if (!EMAIL_RE.test(e)) return { ok: false, error: `'${e}' is not a valid email address` };
      if (e === ownerEmail) continue; // skip duplicate of owner
      if (adminEmails.includes(e)) continue;
      adminEmails.push(e);
    }
    if (adminEmails.length > MAX_ADMIN_EMAILS) {
      return { ok: false, error: `At most ${MAX_ADMIN_EMAILS} additional admin emails are allowed` };
    }
  }

  let plan: string | null = null;
  if (body.plan !== undefined && body.plan !== null && body.plan !== "") {
    if (typeof body.plan !== "string" || !body.plan.trim() || body.plan.trim().length > MAX_PLAN) {
      return { ok: false, error: `'plan' must be 1-${MAX_PLAN} characters` };
    }
    plan = body.plan.trim();
  }

  let seats: number | null = null;
  if (body.seats !== undefined && body.seats !== null && body.seats !== "") {
    const n = typeof body.seats === "number" ? body.seats : Number(body.seats);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SEATS) {
      return { ok: false, error: `'seats' must be a whole number from 1 to ${MAX_SEATS}` };
    }
    seats = n;
  }

  let features: Record<string, boolean> | null = null;
  if (body.features !== undefined && body.features !== null) {
    if (!isObject(body.features)) return { ok: false, error: "'features' must be an object" };
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(body.features)) {
      if (!(PLATFORM_FEATURES as readonly string[]).includes(k)) {
        return { ok: false, error: `Unknown feature '${k}'` };
      }
      if (typeof v !== "boolean") {
        return { ok: false, error: `Feature '${k}' must be true or false` };
      }
      out[k] = v;
    }
    features = out;
  }

  return { ok: true, value: { companyName, legalName, ownerEmail, ownerName, adminEmails, plan, seats, features } };
}

export interface UpdateTenantInput {
  status?: "active" | "suspended";
  reason?: string | null;
  name?: string;
  legalName?: string | null;
  plan?: string;
  /** A key set to null removes that limit. */
  limits?: Record<string, number | null>;
  /** A key set to null removes that override (back to the default). */
  features?: Record<string, boolean | null>;
  /** Re-run the per-account defaults (platform_reseed_account). */
  reseed?: true;
}

/** Upper bound for each operator limit (seats are people, broadcasts are recipients, the rest are counts, tokens and megabytes). */
function maxFor(limit: string): number {
  switch (limit) {
    case "broadcast_per_day":
      return 1_000_000;
    case "contacts":
      return 100_000_000;
    case "messages_per_month":
      return 1_000_000_000;
    case "ai_tokens_per_month":
      return 1_000_000_000_000;
    case "storage_mb":
      return 100_000_000;
    case "sign_documents_per_month":
      return 10_000_000;
    default:
      return MAX_SEATS;
  }
}

export function parseUpdateTenant(body: unknown): Result<UpdateTenantInput> {
  if (!isObject(body)) return { ok: false, error: "Invalid request body" };
  const out: UpdateTenantInput = {};

  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "suspended") {
      return { ok: false, error: "'status' must be 'active' or 'suspended'" };
    }
    out.status = body.status;
  }
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string" || body.reason.length > MAX_REASON) {
      return { ok: false, error: `'reason' must be at most ${MAX_REASON} characters` };
    }
    out.reason = body.reason.trim() || null;
  }
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > MAX_NAME) {
      return { ok: false, error: `'name' must be 1-${MAX_NAME} characters` };
    }
    out.name = body.name.trim();
  }
  if (body.legalName !== undefined) {
    if (body.legalName === null || body.legalName === "") {
      out.legalName = null;
    } else if (typeof body.legalName !== "string" || body.legalName.trim().length > MAX_NAME) {
      return { ok: false, error: `'legalName' must be at most ${MAX_NAME} characters` };
    } else {
      out.legalName = body.legalName.trim() || null;
    }
  }
  if (body.plan !== undefined) {
    if (typeof body.plan !== "string" || !body.plan.trim() || body.plan.trim().length > MAX_PLAN) {
      return { ok: false, error: `'plan' must be 1-${MAX_PLAN} characters` };
    }
    out.plan = body.plan.trim();
  }
  if (body.reseed !== undefined) {
    if (body.reseed !== true) return { ok: false, error: "'reseed' must be true" };
    out.reseed = true;
  }
  if (body.limits !== undefined) {
    if (!isObject(body.limits)) return { ok: false, error: "'limits' must be an object" };
    const limits: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(body.limits)) {
      if (!(PLATFORM_LIMITS as readonly string[]).includes(k)) {
        return { ok: false, error: `Unknown limit '${k}'` };
      }
      if (v === null) {
        limits[k] = null;
      } else if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= maxFor(k)) {
        limits[k] = v;
      } else {
        return { ok: false, error: `Limit '${k}' must be null or a whole number from 1 to ${maxFor(k)}` };
      }
    }
    out.limits = limits;
  }
  if (body.features !== undefined) {
    if (!isObject(body.features)) return { ok: false, error: "'features' must be an object" };
    const features: Record<string, boolean | null> = {};
    for (const [k, v] of Object.entries(body.features)) {
      if (!(PLATFORM_FEATURES as readonly string[]).includes(k)) {
        return { ok: false, error: `Unknown feature '${k}'` };
      }
      if (v !== null && typeof v !== "boolean") {
        return { ok: false, error: `Feature '${k}' must be true, false or null` };
      }
      features[k] = v;
    }
    out.features = features;
  }

  if (Object.keys(out).length === 0) return { ok: false, error: "Nothing to update" };
  return { ok: true, value: out };
}
