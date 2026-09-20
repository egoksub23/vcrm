import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/types";
import { readMigration } from "@/lib/testing/read-migration";

import { DEFAULT_JIRA_SETTINGS, JIRA_SCOPES } from "./types";

// A static read of migration 085. The live behaviour is proven by
// supabase/ci/verify-085-jira.sql (a rolled-back DO block against the real
// database); this pins the shape the app depends on, so an edit that drops a
// guard fails in CI, not in production.

const sql = readMigration("085_jira_link.sql");

const TABLES = [
  "jira_connections",
  "jira_connection_secrets",
  "ticket_jira_links",
  "jira_comment_map",
  "jira_user_map",
  "jira_webhook_events",
  "jira_sync_jobs",
  "jira_sync_events",
];

function fn(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const next = sql.indexOf("CREATE OR REPLACE FUNCTION public.", start + 10);
  return sql.slice(start, next === -1 ? undefined : next);
}

describe("migration 085: tables and access", () => {
  for (const t of TABLES) {
    it(`${t} has row level security on and no client write policy`, () => {
      expect(sql).toContain(`ALTER TABLE public.${t}`.replace(/$/, "") ); // the ENABLE list below
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
      expect(sql).not.toMatch(new RegExp(`CREATE POLICY \\w+ ON public\\.${t}\\s+FOR (INSERT|UPDATE|DELETE|ALL)`));
    });
  }

  it("the secrets and webhook-event tables have no policy at all and are closed to every client role", () => {
    expect(sql).not.toMatch(/CREATE POLICY \w+ ON public\.jira_connection_secrets/);
    expect(sql).not.toMatch(/CREATE POLICY \w+ ON public\.jira_webhook_events/);
    expect(sql).toMatch(/REVOKE ALL ON public\.jira_connection_secrets FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/REVOKE ALL ON public\.jira_webhook_events\s+FROM PUBLIC, anon, authenticated;/);
  });

  it("tokens exist only in the secrets table, never in the readable connection table", () => {
    const conn = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS public.jira_connections"), sql.indexOf("CREATE TABLE IF NOT EXISTS public.jira_connection_secrets"));
    expect(conn).not.toMatch(/token_enc|access_token\b|refresh_token\b|webhook_token|secret/);
    const secrets = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS public.jira_connection_secrets"), sql.indexOf("CREATE TABLE IF NOT EXISTS public.ticket_jira_links"));
    expect(secrets).toContain("access_token_enc");
    expect(secrets).toContain("refresh_token_enc");
    expect(secrets).toContain("webhook_token       TEXT NOT NULL UNIQUE");
  });

  it("clients can only SELECT the safe tables, scoped to their workspace; diagnostics need jira.connect", () => {
    for (const t of ["jira_connections", "ticket_jira_links", "jira_comment_map", "jira_user_map"]) {
      expect(sql).toMatch(new RegExp(`CREATE POLICY ${t}_select ON public\\.${t}\\s+FOR SELECT USING \\(is_account_member\\(account_id\\)\\)`));
    }
    for (const t of ["jira_sync_jobs", "jira_sync_events"]) {
      expect(sql).toMatch(new RegExp(`CREATE POLICY ${t}_select ON public\\.${t}\\s+FOR SELECT USING \\(has_capability\\(account_id, 'jira.connect'\\)\\)`));
    }
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON[\s\S]*?FROM PUBLIC, anon, authenticated;/);
  });

  it("one connection per workspace, a UUID cloud id, and ids are permanent", () => {
    expect(sql).toMatch(/UNIQUE \(account_id\)\s*\);/);
    expect(sql).toContain("cloud_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'");
    expect(sql).toContain("UNIQUE (ticket_id, issue_id)");
    expect(sql).toContain("UNIQUE (link_id, jira_comment_id)");
    expect(sql).toContain("UNIQUE (link_id, ticket_comment_id)");
    expect(sql).toContain("UNIQUE (connection_id, delivery_id)");
  });
});

describe("migration 085: rules in the database", () => {
  it("limits a ticket to five links with a race-safe trigger", () => {
    const body = fn("jira_link_guard");
    expect(body).toContain("pg_advisory_xact_lock");
    expect(body).toMatch(/>= 5/);
    expect(body).toContain("jira_link_limit");
    expect(sql).toMatch(/CREATE TRIGGER jira_link_guard BEFORE INSERT ON public\.ticket_jira_links/);
  });

  it("the job claim uses FOR UPDATE SKIP LOCKED and the pending-job de-duplication is a partial unique index", () => {
    expect(fn("jira_claim_jobs")).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_jira_sync_jobs_pending_dedupe[\s\S]*?WHERE status = 'pending' AND dedupe_key IS NOT NULL/);
  });

  it("token rotation is one compare-and-swap that needs the lease AND the refresh token it started from", () => {
    const body = fn("jira_save_rotated_tokens");
    expect(body).toContain("refresh_lease_owner = p_owner");
    expect(body).toContain("refresh_token_enc = p_expected_refresh");
    expect(body).toContain("access_token_enc = p_access_enc");
    expect(body.match(/UPDATE jira_connection_secrets/g)).toHaveLength(1); // both tokens in one statement
    expect(fn("jira_claim_refresh")).toMatch(/refresh_lease_until IS NULL\s+OR refresh_lease_until < now\(\)/);
  });

  it("a change that came from Jira never queues an outbound push", () => {
    expect(fn("jira_queue_status_push")).toContain("current_setting('vircle.source', true)");
    expect(fn("jira_apply_ticket_status")).toContain("set_config('vircle.source', 'jira', true)");
    expect(fn("log_ticket_activity")).toContain("'jira_status_synced'");
  });

  it("a client cannot forge or change where a note came from", () => {
    const body = fn("ticket_comment_source_guard");
    expect(body).toContain("auth.uid() IS NOT NULL");
    expect(body).toContain("NEW.source := 'vircle'");
    expect(body).toContain("NEW.source := OLD.source");
  });

  it("the push trigger reads the same settings key the app writes", () => {
    expect(fn("jira_queue_status_push")).toContain("'direction' ->> 'status_to_jira'");
    expect(Object.keys(DEFAULT_JIRA_SETTINGS.direction)).toContain("status_to_jira");
  });
});

describe("migration 085: every function is closed to clients", () => {
  const SERVICE_ONLY = [
    ["jira_enqueue_job", "uuid, uuid, text, jsonb, text, integer"],
    ["jira_claim_jobs", "integer, text, integer"],
    ["jira_finish_job", "uuid, text, text, text, integer"],
    ["jira_claim_refresh", "uuid, text, integer"],
    ["jira_save_rotated_tokens", "uuid, text, text, text, text, timestamptz"],
    ["jira_release_refresh", "uuid, text"],
    ["jira_mark_reauth", "uuid, text"],
    ["jira_apply_ticket_status", "uuid, text, text"],
    ["jira_audit", "uuid, uuid, text, text, uuid, text, jsonb"],
    ["jira_prune", ""],
  ] as const;

  for (const [name, sig] of SERVICE_ONLY) {
    it(`${name} is SECURITY DEFINER, pinned to public, not executable by clients, executable by the service role`, () => {
      const body = fn(name);
      expect(body).toContain("SECURITY DEFINER");
      expect(body).toContain("SET search_path = public");
      const s = sig.replace(/[()]/g, "\\$&");
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(${s}\\)\\s+FROM PUBLIC, anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(${s}\\)\\s+TO service_role;`));
    });
  }

  it("jira_audit only writes the two Jira entity types", () => {
    expect(fn("jira_audit")).toContain("p_entity_type NOT IN ('jira_connection', 'ticket_jira_link')");
  });
});

describe("migration 085: the app and the SQL agree", () => {
  it("widens the audit action check with the actions the app logs, and the entity types are known to the UI", () => {
    for (const a of ["connected", "disconnected", "reconnected", "linked", "unlinked"]) {
      expect(sql).toContain(`'${a}'`);
      expect(AUDIT_ACTIONS).toContain(a);
    }
    for (const e of ["jira_connection", "ticket_jira_link"]) expect(AUDIT_ENTITY_TYPES).toContain(e);
  });

  it("adds the notification types and keeps the approval ones so 084 then 085 ends in one set", () => {
    for (const t of ["jira_reauth_required", "jira_issue_done", "approval_requested", "approval_decided"]) expect(sql).toContain(`'${t}'`);
  });

  it("adds the activity events the ticket view renders", () => {
    for (const e of ["jira_linked", "jira_unlinked", "jira_status_synced", "jira_status_pushed"]) expect(sql).toContain(`'${e}'`);
  });

  it("rebuilds every CHECK from the live definition (never a hard-coded list) and reads both shapes pg prints", () => {
    expect(sql.match(/public\.jira_check_values\(/g)!.length).toBeGreaterThanOrEqual(4);
    expect(sql).toContain("string_to_array(replace(btrim(m[1], '{}')");
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.jira_check_values\(text\);\s*$/);
  });

  it("the job kinds the database accepts are the ones the worker handles", () => {
    for (const k of ["sync_issue", "push_status", "post_comment", "edit_comment"]) expect(sql).toContain(`'${k}'`);
  });

  it("requests the five classic scopes and nothing administrative", () => {
    expect([...JIRA_SCOPES]).toEqual(["read:jira-work", "write:jira-work", "read:jira-user", "manage:jira-webhook", "offline_access"]);
  });
});
