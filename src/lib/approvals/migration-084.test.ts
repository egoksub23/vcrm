import { describe, expect, it } from "vitest";

import { readMigration } from "@/lib/testing/read-migration";

import { APPROVAL_ERROR_CODES } from "./types";

// A static read of migration 084. The live behaviour is proven by
// supabase/ci/verify-084-approvals.sql (a rolled-back DO block against the
// real database); this pins the shape that the app depends on so an edit that
// drops a guard fails in CI, not in production.

const sql = readMigration("084_approvals.sql");

function fn(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const next = sql.indexOf("CREATE OR REPLACE FUNCTION public.", start + 10);
  return sql.slice(start, next === -1 ? undefined : next);
}

const CLIENT_RPCS: Record<string, string[]> = {
  propose_tag: ["tags.manage", "tags.propose"],
  propose_tag_edit: ["tags.manage", "tags.propose"],
  propose_snippet: ["snippets.manage", "snippets.propose"],
  propose_snippet_edit: ["snippets.manage", "snippets.propose"],
  withdraw_proposal: [],
  decide_proposal: ["approvals.review", "knowledge.publish"],
  approvals_list: ["approvals.review"],
  approvals_pending_count: ["approvals.review"],
};

describe("migration 084: RPCs", () => {
  for (const [name, caps] of Object.entries(CLIENT_RPCS)) {
    it(`${name} is SECURITY DEFINER, pinned to public, and checks ${caps.join(" / ") || "the proposer"}`, () => {
      const body = fn(name);
      expect(body).toContain("SECURITY DEFINER");
      expect(body).toContain("SET search_path = public");
      for (const cap of caps) expect(body, cap).toContain(`'${cap}'`);
    });

    it(`${name} is executable by signed-in users only`, () => {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\)\\s+FROM PUBLIC, anon;`));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\)\\s+TO authenticated;`));
    });
  }

  it("keeps the internal helpers away from clients", () => {
    for (const name of [
      "approval_guard",
      "approvals_caller",
      "approvals_notify_reviewers",
      "approvals_notify_proposer",
      "approvals_clean_tag_patch",
      "approvals_clean_snippet_patch",
    ]) {
      expect(sql, name).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\)\\s+FROM PUBLIC, anon, authenticated;`));
    }
  });

  it("only raises error codes the app knows a message for", () => {
    const raised = new Set(
      [...sql.matchAll(/RAISE EXCEPTION '([a-z_]+)'\s+USING ERRCODE/g)].map((m) => m[1]),
    );
    expect(raised.size).toBeGreaterThan(8);
    for (const code of raised) {
      expect(APPROVAL_ERROR_CODES as readonly string[], code).toContain(code);
    }
  });

  it("logs every proposal and decision, and notifies", () => {
    expect(fn("propose_tag")).toContain("'created', 'tag'");
    expect(fn("propose_snippet")).toContain("'created', 'snippet'");
    const decide = fn("decide_proposal");
    expect(decide).toContain("'approved'");
    expect(decide).toContain("'rejected'");
    expect(decide).toContain("approvals_notify_proposer");
    expect(fn("propose_tag_edit")).toContain("approvals_notify_reviewers");
    expect(fn("approvals_notify_reviewers")).toContain("'approval_requested'");
    expect(fn("approvals_notify_reviewers")).toContain("p.user_id IS DISTINCT FROM p_actor");
    expect(fn("approvals_notify_proposer")).toContain("'approval_decided'");
  });

  it("stops anyone from deciding their own proposal and requires a note to reject", () => {
    const decide = fn("decide_proposal");
    expect(decide).toContain("own_proposal");
    expect(decide).toContain("note_required");
    expect(decide).toContain("char_length(v_note) < 3");
  });

  it("checks name conflicts against live approved names only", () => {
    expect(fn("propose_tag")).toContain("t.approval_status = 'approved' AND lower(t.name) = lower(v_name)");
    expect(fn("decide_proposal")).toContain("name_conflict");
  });

  it("soft-deletes a withdrawn creation through the phase 2 mechanism", () => {
    const body = fn("withdraw_proposal");
    expect(body).toContain("DELETE FROM tags WHERE id = p_id");
    expect(body).toContain("DELETE FROM quick_replies WHERE id = p_id");
    expect(body).not.toMatch(/SET LOCAL vircle\.hard_delete/);
  });
});

describe("migration 084: visibility", () => {
  it("hides a proposal from everyone but its proposer and reviewers", () => {
    for (const table of ["tags", "quick_replies"]) {
      const start = sql.indexOf(`CREATE POLICY ${table}_select ON public.${table}`);
      expect(start, table).toBeGreaterThan(-1);
      const policy = sql.slice(start, sql.indexOf(");", start));
      expect(policy).toContain("deleted_at IS NULL");
      expect(policy).toContain("approval_status = 'approved'");
      expect(policy).toContain("proposed_by = auth.uid()");
      expect(policy).toContain("has_capability(account_id, 'approvals.review')");
    }
  });

  it("lets names bind only live approved rows", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_account_name_ci\s+ON public\.tags \(account_id, lower\(name\)\)\s+WHERE deleted_at IS NULL AND approval_status = 'approved'/,
    );
  });

  it("refuses to apply a tag that is not approved, and to use one in an auto-label rule", () => {
    expect(fn("audit_link_before_insert")).toContain("t.approval_status <> 'approved'");
    expect(fn("approval_rule_tag_guard")).toContain("t.approval_status <> 'approved'");
    expect(sql).toContain("BEFORE INSERT OR UPDATE OF tag_id ON public.auto_label_rules");
  });

  it("stops a direct client write from forging the approval columns", () => {
    const guard = fn("approval_guard");
    expect(guard).toContain("vircle.approval_rpc");
    expect(guard).toContain("auth.uid() IS NULL");
    expect(guard).toContain("NEW.approval_status := 'approved'");
    expect(guard).toContain("NEW.approval_status := OLD.approval_status");
    expect(sql).toContain("CREATE TRIGGER approval_guard\n  BEFORE INSERT OR UPDATE ON public.tags");
    expect(sql).toContain("CREATE TRIGGER approval_guard\n  BEFORE INSERT OR UPDATE ON public.quick_replies");
  });

  it("keeps the row audit trigger quiet for proposals (the RPCs log them)", () => {
    const body = fn("audit_row_change");
    expect(body).toContain("vircle.audit_skip");
    expect(body).toContain("n ->> 'approval_status' <> 'approved'");
    expect(body).toContain("o ->> 'approval_status' <> 'approved'");
  });

  it("hides withdrawn proposals from Recently removed", () => {
    const body = fn("audit_removed_items");
    expect(body.match(/approval_status = 'approved'/g)).toHaveLength(2);
  });
});

describe("migration 084: data model", () => {
  it("adds the columns to both tables", () => {
    for (const table of ["tags", "quick_replies"]) {
      const start = sql.indexOf(`ALTER TABLE public.${table}\n  ADD COLUMN IF NOT EXISTS approval_status`);
      expect(start, table).toBeGreaterThan(-1);
      const block = sql.slice(start, sql.indexOf(";", start));
      for (const col of [
        "approval_status TEXT NOT NULL DEFAULT 'approved'",
        "proposed_by",
        "proposed_at",
        "decided_by",
        "decided_at",
        "decision_note",
        "pending_edit    JSONB",
        "edit_status",
      ]) {
        expect(block, `${table} ${col}`).toContain(col);
      }
    }
    expect(sql).toContain("CHECK (approval_status IN (''approved'', ''pending'', ''rejected''))");
  });

  it("widens the notification types from the live constraint, never replacing it", () => {
    expect(sql).toContain("pg_get_constraintdef(oid)");
    expect(sql).toContain("'approval_requested', 'approval_decided'");
    expect(sql).not.toMatch(/CHECK \(type IN \('conversation_assigned'/);
  });

  it("does not touch any workspace's stored role capabilities", () => {
    const withoutComments = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(withoutComments).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM) public\.role_capabilities\b/);
    expect(withoutComments).not.toMatch(/set_role_capabilities\(/);
  });
});
