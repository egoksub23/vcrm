import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HISTORY_DAYS_DEFAULT, HISTORY_DAYS_MAX, HISTORY_DAYS_MIN } from "@/lib/vircle-chat/history";
import { readMigration } from "@/lib/testing/read-migration";

// Guards on the TEXT of migration 193 (Vircle Chat: history_days). The behaviour is proven against a database by
// supabase/ci/verify-193-vircle-chat-history-days.sql (run it rolled back against production, with 193's text in front until it is applied).

const sql = readMigration("193_vircle_chat_history_days.sql").replace(/\r\n/g, "\n");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const verify = readFileSync(join(process.cwd(), "supabase", "ci", "verify-193-vircle-chat-history-days.sql"), "utf8").replace(/\r\n/g, "\n");

describe("migration 193", () => {
  it("is idempotent", () => {
    expect(code).toContain("ADD COLUMN IF NOT EXISTS history_days");
    expect(code).toContain("DROP CONSTRAINT IF EXISTS vircle_chat_config_history_days_check");
    expect(code).toContain("DROP TRIGGER IF EXISTS audit_row_change");
  });

  it("agrees with the code on the default and the limits", () => {
    expect(code).toMatch(/history_days integer NOT NULL DEFAULT 90/);
    expect(code).toMatch(/CHECK \(history_days BETWEEN 1 AND 365\)/);
    expect([HISTORY_DAYS_DEFAULT, HISTORY_DAYS_MIN, HISTORY_DAYS_MAX]).toEqual([90, 1, 365]);
  });

  it("adds no table, policy or grant, and keeps the audit of the connection (now including the setting)", () => {
    expect(code).not.toMatch(/CREATE TABLE|CREATE POLICY|GRANT /);
    expect(code).toContain("'workspace_key,gateway_base_url,signing_secret,api_token,enabled,history_days'");
  });

  it("has a verify script that ends rolled back and covers the limits", () => {
    expect(verify).toContain("ROLLBACK-OK");
    expect(verify).toContain("'0', '366', '-5', 'NULL'");
  });
});
