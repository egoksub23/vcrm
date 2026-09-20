// ============================================================
// Route helpers for /api/integrations/jira/*: building the sync context for
// the caller's workspace, and mapping every typed error to one JSON shape
// { error: <stable code>, message } (never a token, never a stack).
// Server only.
// ============================================================

import { NextResponse } from "next/server";

import { type CapabilityContext, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { getOAuthBaseUrl } from "@/lib/gmail/oauth";

import type { JiraClient } from "./client";
import { isJiraError, JiraError, JiraRateLimitError, JiraValidationError } from "./errors";
import { isJiraConfigured } from "./oauth";
import { LinkError } from "./links";
import { normalizeSettings } from "./settings";
import { clientForConnection, jiraStore } from "./service";
import type { JiraStore } from "./store";
import type { SyncContext } from "./sync";
import type { JiraConnectionRow } from "./types";

/** A refusal raised by a route itself. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

const LINK_STATUS: Record<LinkError["code"], number> = {
  not_found: 404,
  no_connection: 409,
  inactive: 409,
  project_not_allowed: 403,
  link_limit: 409,
  already_linked: 409,
  bad_reference: 400,
  unsupported_fields: 422,
  missing_fields: 422,
  jira_rejected: 422,
  no_permission: 403,
  transition_unavailable: 409,
};

/** Any error a Jira route can throw -> the response. */
export function apiErrorResponse(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.code, message: err.message, ...(err.extra ?? {}) }, { status: err.status });
  }
  if (err instanceof LinkError) {
    return NextResponse.json(
      { error: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) },
      { status: LINK_STATUS[err.code] ?? 400 },
    );
  }
  if (isJiraError(err)) {
    const e: JiraError = err;
    switch (e.code) {
      case "auth":
        return NextResponse.json({ error: "reauth_required", message: "Jira needs to be reconnected" }, { status: 409 });
      case "permission":
        return NextResponse.json({ error: "jira_permission", message: e.message }, { status: 403 });
      case "not_found":
        return NextResponse.json({ error: "jira_not_found", message: e.message }, { status: 404 });
      case "rate_limit": {
        const retry = Math.max(1, Math.ceil(((err as JiraRateLimitError).retryAfterMs ?? 30_000) / 1000));
        return NextResponse.json({ error: "jira_rate_limited", message: e.message, retry_after_seconds: retry }, { status: 429, headers: { "Retry-After": String(retry) } });
      }
      case "validation":
        return NextResponse.json(
          { error: "jira_rejected", message: e.message, messages: (err as JiraValidationError).messages, fieldErrors: (err as JiraValidationError).fieldErrors },
          { status: 422 },
        );
      case "config":
        return NextResponse.json({ error: "jira_not_configured", message: "Jira is not configured on this server" }, { status: 503 });
      default:
        return NextResponse.json({ error: "jira_unavailable", message: "Jira is not reachable right now" }, { status: 502 });
    }
  }
  // 401 / 403 from requireCapability / getCurrentAccount (by shape, so a test double works too).
  const status = (err as { status?: unknown } | null)?.status;
  if (err instanceof Error && (status === 401 || status === 403)) return toErrorResponse(err);
  console.error("[jira route] unexpected error:", err instanceof Error ? err.message : err);
  return NextResponse.json({ error: "internal", message: "Something went wrong" }, { status: 500 });
}

/** The origin of this deployment (for links back to a ticket and the webhook URL). */
export function jiraAppUrl(request?: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  if (!request) return "";
  try {
    return getOAuthBaseUrl(request);
  } catch {
    return "";
  }
}

export interface JiraRouteContext {
  db: ReturnType<typeof supabaseAdmin>;
  store: JiraStore;
  connection: JiraConnectionRow;
  /** The full client (metadata, users, webhooks); `sync.client` is the same object. */
  client: JiraClient;
  sync: SyncContext;
}

/**
 * The caller's workspace connection with a ready client. `requireActive`
 * (default) refuses when there is none or it needs reconnecting.
 */
export async function loadJiraContext(
  ctx: Pick<CapabilityContext, "accountId">,
  request: Request,
  opts: { requireActive?: boolean } = {},
): Promise<JiraRouteContext> {
  if (!isJiraConfigured()) throw new ApiError(503, "jira_not_configured", "Jira is not configured on this server");
  const db = supabaseAdmin();
  const store = jiraStore(db);
  const connection = await store.getConnectionByAccount(ctx.accountId);
  if (!connection || connection.status === "revoked") throw new ApiError(409, "no_connection", "Jira is not connected");
  if ((opts.requireActive ?? true) && connection.status !== "active") {
    throw new ApiError(409, "reauth_required", "Jira needs to be reconnected");
  }
  const client = clientForConnection(db, connection, { store });
  const sync: SyncContext = {
    store,
    client,
    connection,
    settings: normalizeSettings(connection.settings),
    appUrl: jiraAppUrl(request),
  };
  return { db, store, connection, client, sync };
}
