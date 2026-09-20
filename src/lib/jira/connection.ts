// ============================================================
// The connection's life: finish a sign-in (create or refresh the connection
// and its encrypted tokens), register and renew the Jira webhooks, and
// disconnect. Server only (it writes the secrets table).
//
// Webhook registration follows the research notes: a dynamic webhook per
// connection, events issue_updated / issue_deleted / comment_*, a JQL filter
// limited to the projects that have linked issues (or the allowed projects).
// Whether Jira delivers them to a site this app does not own is unproven (see
// docs/jira-setup.md); the catch-up poll works either way.
// ============================================================

import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { encrypt } from "@/lib/whatsapp/encryption";

import { buildWebhookJql } from "./catchup";
import type { JiraClient } from "./client";
import { describeError } from "./errors";
import type { AccessibleSite, TokenSet } from "./oauth";
import { normalizeSettings } from "./settings";
import type { JiraStore } from "./store";
import {
  JIRA_WEBHOOK_EVENTS,
  WEBHOOK_RENEW_BEFORE_DAYS,
  WEBHOOK_LIFETIME_DAYS,
  type JiraConnectionRow,
} from "./types";

export class ConnectError extends Error {
  constructor(readonly code: "site_mismatch" | "not_configured", message: string) {
    super(message);
    this.name = "ConnectError";
  }
}

/**
 * Save a finished sign-in. A first connection is created; a reconnect to the
 * SAME site refreshes the tokens and resumes the paused links; a different
 * site is refused while links to the old one exist (Disconnect and "Remove
 * cached Jira data" first).
 */
export async function completeConnection(args: {
  db: SupabaseClient;
  store: JiraStore;
  accountId: string;
  userId: string;
  site: AccessibleSite;
  tokens: TokenSet;
  myself: { accountId: string; displayName?: string } | null;
}): Promise<{ connection: JiraConnectionRow; reconnected: boolean }> {
  const { db, store, accountId, site, tokens } = args;
  const existing = await store.getConnectionByAccount(accountId);

  if (existing && existing.cloud_id !== site.id) {
    const links = await store.linksForConnection(existing.id);
    if (links.length > 0) {
      throw new ConnectError(
        "site_mismatch",
        "This workspace has tickets linked to another Jira site. Disconnect and remove the cached Jira data before connecting a different site.",
      );
    }
  }

  const fields = {
    cloud_id: site.id,
    site_url: site.url,
    site_name: site.name,
    connected_by: args.userId,
    jira_account_id: args.myself?.accountId ?? null,
    jira_display_name: args.myself?.displayName ?? null,
    status: "active",
    status_reason: null,
    token_expires_at: tokens.expiresAt.toISOString(),
  };

  let connectionId: string;
  const reconnected = !!existing;
  if (existing) {
    connectionId = existing.id;
    const { error } = await db.from("jira_connections").update({ ...fields, webhook_ids: existing.cloud_id === site.id ? existing.webhook_ids : [], ...(existing.cloud_id === site.id ? {} : { webhook_expires_at: null, last_catchup_at: null }) }).eq("id", existing.id);
    if (error) throw new Error(`Could not update the Jira connection: ${error.message}`);
    if (existing.cloud_id !== site.id) {
      // Another site has other fields and projects: the old field mappings and metadata do not carry over.
      await db.from("jira_field_mappings").delete().eq("connection_id", existing.id);
      await db.from("jira_field_meta_cache").delete().eq("connection_id", existing.id);
    }
    const { error: sErr } = await db
      .from("jira_connection_secrets")
      .upsert(
        {
          connection_id: existing.id,
          account_id: accountId,
          access_token_enc: encrypt(tokens.accessToken),
          refresh_token_enc: encrypt(tokens.refreshToken),
          // Keep the webhook token: it is already in the registered URL.
          webhook_token: await currentWebhookToken(db, existing.id),
          refresh_lease_owner: null,
          refresh_lease_until: null,
          rotated_at: new Date().toISOString(),
        },
        { onConflict: "connection_id" },
      );
    if (sErr) throw new Error(`Could not store the Jira tokens: ${sErr.message}`);
    // The paused links (the connection was lost) resume.
    for (const l of await store.linksForConnection(existing.id, ["paused"])) await store.updateLink(l.id, { sync_state: "ok", sync_error: null });
  } else {
    const { data, error } = await db
      .from("jira_connections")
      .insert({ account_id: accountId, ...fields, settings: normalizeSettings({}) })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Could not create the Jira connection: ${error?.message ?? "unknown error"}`);
    connectionId = (data as { id: string }).id;
    const { error: sErr } = await db.from("jira_connection_secrets").insert({
      connection_id: connectionId,
      account_id: accountId,
      access_token_enc: encrypt(tokens.accessToken),
      refresh_token_enc: encrypt(tokens.refreshToken),
      webhook_token: randomBytes(32).toString("base64url"),
    });
    if (sErr) {
      await db.from("jira_connections").delete().eq("id", connectionId);
      throw new Error(`Could not store the Jira tokens: ${sErr.message}`);
    }
  }

  const connection = (await store.getConnection(connectionId))!;
  await store.audit({
    accountId,
    actorId: args.userId,
    action: reconnected ? "reconnected" : "connected",
    entityType: "jira_connection",
    entityId: connectionId,
    label: site.name,
    summary: { site: site.name, jira_user: args.myself?.displayName ?? null },
  });
  return { connection, reconnected };
}

async function currentWebhookToken(db: SupabaseClient, connectionId: string): Promise<string> {
  const { data } = await db.from("jira_connection_secrets").select("webhook_token").eq("connection_id", connectionId).maybeSingle();
  return (data as { webhook_token?: string } | null)?.webhook_token ?? randomBytes(32).toString("base64url");
}

// ------------------------------------------------------------
// Webhooks
// ------------------------------------------------------------

export interface WebhookReport {
  action: "none" | "registered" | "refreshed" | "replaced" | "removed" | "skipped" | "failed";
  detail?: string;
  ids?: number[];
  expiresAt?: string | null;
}

/** Projects the webhook must cover: those with linked issues, plus the allowed list. */
export async function webhookProjects(store: JiraStore, connection: JiraConnectionRow): Promise<string[]> {
  const links = await store.linksForConnection(connection.id, ["ok", "broken"]);
  const set = new Set<string>(normalizeSettings(connection.settings).projects.allowed);
  for (const l of links) if (l.project_key) set.add(l.project_key.toUpperCase());
  return [...set].sort();
}

const asIds = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);

/**
 * Make Jira's webhook registration match what is needed: register when
 * missing, replace when the project set changed, otherwise extend its
 * 30 days. Idempotent; safe to run daily and after linking a first issue.
 */
export async function ensureWebhooks(args: {
  db: SupabaseClient;
  store: JiraStore;
  client: JiraClient;
  connection: JiraConnectionRow;
  baseUrl: string;
  webhookToken: string;
  now?: () => number;
}): Promise<WebhookReport> {
  const { store, client, connection } = args;
  const now = (args.now ?? Date.now)();
  const projects = await webhookProjects(store, connection);
  const jql = buildWebhookJql(projects);
  const known = asIds(connection.webhook_ids);
  const stamp = { webhook_checked_at: new Date(now).toISOString() };

  const listed = known.length ? ((await client.listWebhooks())?.values ?? []) : [];
  const alive = listed.filter((w) => known.includes(w.id));

  if (!jql) {
    if (known.length) {
      await client.deleteWebhooks(known).catch(() => undefined);
      await store.updateConnection(connection.id, { webhook_ids: [], webhook_expires_at: null, ...stamp });
      return { action: "removed", detail: "no linked issues yet" };
    }
    await store.updateConnection(connection.id, stamp);
    return { action: "none", detail: "no linked issues yet" };
  }

  if (!args.baseUrl.startsWith("https://")) {
    await store.updateConnection(connection.id, stamp);
    return { action: "skipped", detail: "Jira only delivers webhooks to https addresses" };
  }

  const wanted = alive.length > 0 && alive.every((w) => (w.jqlFilter ?? "") === jql);
  if (wanted) {
    const res = await client.refreshWebhooks(alive.map((w) => w.id));
    const expiresAt = res?.expirationDate ?? new Date(now + WEBHOOK_LIFETIME_DAYS * 86_400_000).toISOString();
    await store.updateConnection(connection.id, { webhook_expires_at: expiresAt, ...stamp });
    return { action: "refreshed", ids: alive.map((w) => w.id), expiresAt };
  }

  const replacing = alive.length > 0;
  if (replacing) await client.deleteWebhooks(alive.map((w) => w.id)).catch(() => undefined);

  const url = `${args.baseUrl.replace(/\/+$/, "")}/api/integrations/jira/webhook/${args.webhookToken}`;
  try {
    const res = await client.registerWebhooks({ url, events: JIRA_WEBHOOK_EVENTS, jqlFilter: jql });
    const created = (res?.webhookRegistrationResult ?? []).flatMap((r) => (typeof r.createdWebhookId === "number" ? [r.createdWebhookId] : []));
    const errors = (res?.webhookRegistrationResult ?? []).flatMap((r) => r.errors ?? []);
    if (created.length === 0) {
      await store.updateConnection(connection.id, { webhook_ids: [], webhook_expires_at: null, ...stamp });
      await store.logEvent({
        accountId: connection.account_id,
        connectionId: connection.id,
        level: "error",
        kind: "webhook_register_failed",
        message: errors.join("; ").slice(0, 300) || "Jira refused the webhook registration",
      });
      return { action: "failed", detail: errors[0] ?? "refused" };
    }
    const expiresAt = new Date(now + WEBHOOK_LIFETIME_DAYS * 86_400_000).toISOString();
    await store.updateConnection(connection.id, { webhook_ids: created, webhook_expires_at: expiresAt, ...stamp });
    return { action: replacing ? "replaced" : "registered", ids: created, expiresAt };
  } catch (e) {
    await store.logEvent({
      accountId: connection.account_id,
      connectionId: connection.id,
      level: "error",
      kind: "webhook_register_failed",
      message: describeError(e),
    });
    await store.updateConnection(connection.id, stamp);
    return { action: "failed", detail: describeError(e) };
  }
}

/** Is a renewal due? (Daily job, or when the webhook is within its renewal window.) */
export function webhookRenewalDue(connection: Pick<JiraConnectionRow, "webhook_checked_at" | "webhook_expires_at">, now: number): boolean {
  const checked = connection.webhook_checked_at ? Date.parse(connection.webhook_checked_at) : 0;
  if (!Number.isFinite(checked) || now - checked > 23 * 3_600_000) return true;
  const exp = connection.webhook_expires_at ? Date.parse(connection.webhook_expires_at) : NaN;
  return Number.isFinite(exp) && exp - now < (WEBHOOK_LIFETIME_DAYS - WEBHOOK_RENEW_BEFORE_DAYS) * 86_400_000;
}

// ------------------------------------------------------------
// Disconnect
// ------------------------------------------------------------

/**
 * Disconnect: deregister the webhooks (best effort), delete the tokens, mark
 * the connection revoked and pause its links. With `purge`, also remove every
 * cached Jira row (links with their comment map, queued jobs, diagnostics,
 * the user map). Notes that were copied from Jira stay: they are ticket
 * history now.
 */
export async function disconnect(args: {
  db: SupabaseClient;
  store: JiraStore;
  client: JiraClient | null;
  connection: JiraConnectionRow;
  userId: string | null;
  purge: boolean;
}): Promise<{ webhooksRemoved: boolean }> {
  const { db, store, connection } = args;
  let webhooksRemoved = false;
  const ids = asIds(connection.webhook_ids);
  if (args.client && ids.length && connection.status === "active") {
    try {
      await args.client.deleteWebhooks(ids);
      webhooksRemoved = true;
    } catch {
      // Best effort: Jira expires them within 30 days anyway.
    }
  }

  await db.from("jira_connection_secrets").delete().eq("connection_id", connection.id);
  await db
    .from("jira_connections")
    .update({ status: "revoked", status_reason: "disconnected", webhook_ids: [], webhook_expires_at: null, token_expires_at: null })
    .eq("id", connection.id);
  await db.from("jira_sync_jobs").delete().eq("connection_id", connection.id);

  if (args.purge) {
    await db.from("ticket_jira_links").delete().eq("connection_id", connection.id);
    await db.from("jira_sync_events").delete().eq("connection_id", connection.id);
    await db.from("jira_user_map").delete().eq("account_id", connection.account_id);
    // Bulk batches (with their results) and the cached field metadata are cached Jira data too.
    await db.from("jira_bulk_batches").delete().eq("connection_id", connection.id);
    await db.from("jira_field_meta_cache").delete().eq("connection_id", connection.id);
  } else {
    await db.from("ticket_jira_links").update({ sync_state: "paused" }).eq("connection_id", connection.id).eq("sync_state", "ok");
  }

  await store.audit({
    accountId: connection.account_id,
    actorId: args.userId,
    action: "disconnected",
    entityType: "jira_connection",
    entityId: connection.id,
    label: connection.site_name ?? "Jira",
    summary: { site: connection.site_name, purged: args.purge, webhooks_removed: webhooksRemoved },
  });
  return { webhooksRemoved };
}
