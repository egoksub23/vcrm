// ============================================================
// Server-side glue: the Supabase-backed token store, and a factory that
// builds a ready-to-use JiraClient for a connection (refresh-on-expiry,
// single-flight, rate-limit logging). Server only: it decrypts tokens.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { decrypt, encrypt } from "@/lib/whatsapp/encryption";

import { CHAT_MEDIA_BUCKET, type AttachmentStorage } from "./attachments";
import { JiraClient } from "./client";
import type { CronContext, CronDeps } from "./cron";
import { JiraConfigError } from "./errors";
import { readOAuthConfig, type TokenSet } from "./oauth";
import { normalizeSettings } from "./settings";
import { SupabaseJiraStore, type JiraStore } from "./store";
import { TokenManager, type StoredTokens, type TokenStore } from "./tokens";
import type { JiraConnectionRow, RateLimitSnapshot } from "./types";
import type { WebhookStore } from "./webhook-handler";
import { CONNECTION_COLUMNS } from "./types";

export function jiraStore(db: SupabaseClient = supabaseAdmin()): JiraStore {
  return new SupabaseJiraStore(db);
}

/** The chat-media bucket on the service role (the bucket itself is not touched by Jira). */
export function attachmentStorage(db: SupabaseClient = supabaseAdmin()): AttachmentStorage {
  const bucket = () => db.storage.from(CHAT_MEDIA_BUCKET);
  return {
    async download(path) {
      const { data, error } = await bucket().download(path);
      if (error || !data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async upload(path, data, contentType) {
      const { error } = await bucket().upload(path, data, { contentType, cacheControl: "3600", upsert: false });
      return { error: error?.message ?? null };
    },
    async remove(path) {
      await bucket().remove([path]);
    },
    publicUrl(path) {
      return bucket().getPublicUrl(path).data.publicUrl;
    },
  };
}

/** The token store for one connection, on the service role. */
export function supabaseTokenStore(db: SupabaseClient, connectionId: string): TokenStore {
  return {
    key: connectionId,
    async read(): Promise<StoredTokens> {
      const [{ data: secrets, error }, { data: conn }] = await Promise.all([
        db.from("jira_connection_secrets").select("access_token_enc, refresh_token_enc").eq("connection_id", connectionId).maybeSingle(),
        db.from("jira_connections").select("token_expires_at").eq("id", connectionId).maybeSingle(),
      ]);
      const s = secrets as { access_token_enc?: string; refresh_token_enc?: string } | null;
      if (error || !s?.access_token_enc || !s.refresh_token_enc) {
        throw new JiraConfigError("This Jira connection has no stored tokens");
      }
      const exp = (conn as { token_expires_at?: string | null } | null)?.token_expires_at;
      return {
        accessToken: decrypt(s.access_token_enc),
        refreshToken: decrypt(s.refresh_token_enc),
        expiresAt: exp ? new Date(exp) : null,
        cas: s.refresh_token_enc,
      };
    },
    async claim(owner, leaseSeconds) {
      const { data, error } = await db.rpc("jira_claim_refresh", {
        p_connection_id: connectionId,
        p_owner: owner,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new Error(`jira_claim_refresh failed: ${error.message}`);
      return data === true;
    },
    async saveRotated({ owner, expectedCas, tokens }: { owner: string; expectedCas: string; tokens: TokenSet }) {
      const { data, error } = await db.rpc("jira_save_rotated_tokens", {
        p_connection_id: connectionId,
        p_owner: owner,
        p_expected_refresh: expectedCas,
        p_access_enc: encrypt(tokens.accessToken),
        p_refresh_enc: encrypt(tokens.refreshToken),
        p_expires_at: tokens.expiresAt.toISOString(),
      });
      if (error) throw new Error(`jira_save_rotated_tokens failed: ${error.message}`);
      return data === true;
    },
    async release(owner) {
      await db.rpc("jira_release_refresh", { p_connection_id: connectionId, p_owner: owner });
    },
    async markReauth(reason) {
      await db.rpc("jira_mark_reauth", { p_connection_id: connectionId, p_reason: reason });
    },
  };
}

// Remember the last rate-limit header set per connection, and write it at
// most every 30 s (and always when Atlassian named a reason).
const lastRateWrite = new Map<string, number>();

/** A client for `connection`. Tokens are refreshed on demand and never leave this module. */
export function clientForConnection(
  db: SupabaseClient,
  connection: Pick<JiraConnectionRow, "id" | "account_id" | "cloud_id">,
  deps: { fetch?: typeof fetch; store?: JiraStore } = {},
): JiraClient {
  const config = readOAuthConfig();
  const tokens = new TokenManager(supabaseTokenStore(db, connection.id), config, { fetch: deps.fetch });
  const store = deps.store ?? jiraStore(db);
  return new JiraClient({
    cloudId: connection.cloud_id,
    connectionKey: connection.id,
    fetch: deps.fetch,
    getAccessToken: (o) => tokens.getAccessToken(o),
    // Jira refuses even a fresh token (user deactivated, app removed): links pause, people are told.
    onAuthFailure: () => store.markReauth(connection.id, "Jira rejected the access token"),
    onRateLimit: (snap: RateLimitSnapshot) => {
      const now = Date.now();
      const last = lastRateWrite.get(connection.id) ?? 0;
      if (!snap.reason && now - last < 30_000) return;
      lastRateWrite.set(connection.id, now);
      void db
        .from("jira_connections")
        .update({ rate_limit: snap })
        .eq("id", connection.id)
        .then(
          () => undefined,
          () => undefined,
        );
      if (snap.reason || snap.status === 429) {
        void store.logEvent({
          accountId: connection.account_id,
          connectionId: connection.id,
          level: "warn",
          kind: "rate_limit",
          message: `Jira rate limit: ${snap.reason ?? "429"}`,
          details: { ...snap },
        });
      }
    },
  });
}

export async function readWebhookToken(db: SupabaseClient, connectionId: string): Promise<string | null> {
  const { data } = await db.from("jira_connection_secrets").select("webhook_token").eq("connection_id", connectionId).maybeSingle();
  return (data as { webhook_token?: string } | null)?.webhook_token ?? null;
}

/** Everything the cron runner needs, on the service role. */
export function cronDeps(baseUrl: string, db: SupabaseClient = supabaseAdmin()): CronDeps {
  const store = jiraStore(db);
  return {
    db,
    store,
    baseUrl,
    readWebhookToken: (id) => readWebhookToken(db, id),
    contextFor: (connection): CronContext => {
      const client = clientForConnection(db, connection, { store });
      return { store, client, connection, settings: normalizeSettings(connection.settings), appUrl: baseUrl, storage: attachmentStorage(db) };
    },
  };
}

/** The receiver's two lookups: the connection for a URL token, and delivery de-duplication. */
export function supabaseWebhookStore(db: SupabaseClient = supabaseAdmin()): WebhookStore {
  return {
    async connectionByToken(token) {
      const { data: secret } = await db
        .from("jira_connection_secrets")
        .select("connection_id, webhook_token")
        .eq("webhook_token", token)
        .maybeSingle();
      const sec = secret as { connection_id?: string; webhook_token?: string } | null;
      if (!sec?.connection_id || !sec.webhook_token) return null;
      const { data: conn } = await db.from("jira_connections").select(CONNECTION_COLUMNS).eq("id", sec.connection_id).maybeSingle();
      return conn ? { connection: conn as JiraConnectionRow, expectedToken: sec.webhook_token } : null;
    },
    async recordDelivery(connectionId, deliveryId, event) {
      const { error } = await db.from("jira_webhook_events").insert({ connection_id: connectionId, delivery_id: deliveryId, event });
      if (error?.code === "23505") return false;
      if (error) throw new Error(`could not record the webhook delivery: ${error.message}`);
      return true;
    },
  };
}
