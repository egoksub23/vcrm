import { describe, expect, it } from "vitest";

import { readMigration } from "@/lib/testing/read-migration";

// A static read of migration 095. The live behaviour (RLS, cross-account
// isolation, the resolution triggers, notification clearing) is proven by
// supabase/ci/verify-095-ticket-mentions.sql, a rolled-back DO block run against
// the real database; this pins the shape the app depends on, so an edit that
// drops a guard fails in CI, not in production.

const sql = readMigration("095_ticket_mentions.sql");

function fn(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const next = sql.indexOf("CREATE OR REPLACE FUNCTION public.", start + 10);
  return sql.slice(start, next === -1 ? undefined : next);
}

describe("migration 095: ticket_mentions", () => {
  it("has the columns the app reads and the value lists it relies on", () => {
    for (const col of [
      "account_id", "ticket_id", "comment_id", "mentioned_user_id", "requested_by",
      "via_team_id", "kind", "status", "created_at", "resolved_at", "resolved_by", "resolved_reason", "nudged_at",
    ]) {
      expect(sql, col).toMatch(new RegExp(`\\n  ${col}\\s+(UUID|TEXT|TIMESTAMPTZ)`));
    }
    expect(sql).toContain("CHECK (kind IN ('response', 'fyi'))");
    expect(sql).toContain("CHECK (status IN ('open', 'done', 'cancelled'))");
    expect(sql).toContain("CHECK (resolved_reason IN ('replied', 'marked_done', 'ticket_closed', 'cancelled'))");
  });

  it("row level security is on, reads only, and the browser cannot write", () => {
    expect(sql).toMatch(/ALTER TABLE public\.ticket_mentions ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE POLICY ticket_mentions_select ON public\.ticket_mentions\s+FOR SELECT/);
    expect(sql).not.toMatch(/CREATE POLICY \w+ ON public\.ticket_mentions\s+FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.ticket_mentions FROM authenticated/);
    expect(sql).toMatch(/REVOKE ALL ON public\.ticket_mentions FROM PUBLIC, anon/);
  });

  it("the read policy is scoped to the account and to own rows or readable tickets", () => {
    const policy = sql.slice(sql.indexOf("CREATE POLICY ticket_mentions_select"));
    const body = policy.slice(0, policy.indexOf(";"));
    expect(body).toContain("is_account_member(account_id)");
    expect(body).toContain("mentioned_user_id = (SELECT auth.uid())");
    expect(body).toContain("requested_by = (SELECT auth.uid())");
    expect(body).toContain("FROM public.tickets t WHERE t.id = ticket_mentions.ticket_id");
  });

  it("an open row carries no resolution, a closed one always does; nobody asks themselves", () => {
    expect(sql).toMatch(/status = 'open' AND resolved_at IS NULL AND resolved_reason IS NULL/);
    expect(sql).toMatch(/status <> 'open' AND resolved_at IS NOT NULL AND resolved_reason IS NOT NULL/);
    expect(sql).toMatch(/CHECK \(requested_by IS DISTINCT FROM mentioned_user_id\)/);
  });

  it("there is one request per person per comment", () => {
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS uq_ticket_mentions_comment_user\s+ON public\.ticket_mentions \(comment_id, mentioned_user_id\)/);
  });

  it("is in the realtime publication and the comment carries the team ids", () => {
    expect(sql).toMatch(/ALTER PUBLICATION supabase_realtime ADD TABLE public\.ticket_mentions/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS mention_teams JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS comment_id UUID REFERENCES public\.ticket_comments\(id\) ON DELETE CASCADE/);
  });
});

describe("migration 095: functions", () => {
  const TRIGGERS = [
    "ticket_mentions_on_comment_insert",
    "ticket_mentions_on_comment_delete",
    "ticket_mentions_on_ticket_status",
    "ticket_mentions_after_change",
  ];

  for (const name of TRIGGERS) {
    it(`${name} runs with the owner's rights, a fixed search path, and is closed to clients`, () => {
      const body = fn(name);
      expect(body).toMatch(/SECURITY DEFINER\s+SET search_path = public/);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(\\)\\s+FROM PUBLIC, anon, authenticated`));
      // Never blocks the real write.
      expect(body).toMatch(/EXCEPTION WHEN OTHERS THEN/);
    });
  }

  it("a reply from the person asked completes their requests (Jira notes do not count)", () => {
    const body = fn("ticket_mentions_on_comment_insert");
    expect(body).toContain("resolved_reason = 'replied'");
    expect(body).toContain("mentioned_user_id = NEW.author_id");
    expect(body).toMatch(/COALESCE\(NEW\.source, 'vircle'\) = 'jira'/);
  });

  it("deleting the comment cancels what is still open, before the row goes", () => {
    const body = fn("ticket_mentions_on_comment_delete");
    expect(body).toContain("resolved_reason = 'cancelled'");
    expect(body).toContain("status = 'open'");
    expect(sql).toMatch(/BEFORE DELETE ON public\.ticket_comments/);
  });

  it("resolving or closing the ticket completes what is open, and only on that move", () => {
    const body = fn("ticket_mentions_on_ticket_status");
    expect(body).toContain("resolved_reason = 'ticket_closed'");
    expect(body).toContain("NEW.status NOT IN ('resolved', 'closed')");
    expect(sql).toMatch(/AFTER UPDATE OF status ON public\.tickets/);
  });

  it("a resolved request marks its bell notification read and is written to the ticket history", () => {
    const body = fn("ticket_mentions_after_change");
    expect(body).toMatch(/UPDATE notifications\s+SET read_at = now\(\)/);
    expect(body).toContain("mention_requested");
    expect(body).toContain("mention_done");
    expect(body).toContain("mention_cancelled");
  });

  it("the history line types are added without losing the live ones", () => {
    expect(sql).toContain("pg_get_constraintdef(oid)");
    expect(sql).toContain("ARRAY['mention_requested', 'mention_done', 'mention_cancelled']");
  });

  it("the mention notification now links to the comment", () => {
    const body = fn("notify_ticket_comment_mentions");
    expect(body).toMatch(/account_id, user_id, type, ticket_id, comment_id,/);
    expect(body).toContain("NEW.id,");
  });
});
