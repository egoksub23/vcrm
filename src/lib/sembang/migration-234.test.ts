import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/234_sembang_p5.sql"), "utf8");

describe("migration 234 (runs on the Halo VPS, which has no Supabase storage schema)", () => {
  it("opens and closes every DO block with a double dollar sign", () => {
    expect(sql).not.toMatch(/DO \$(?!\$)/);
    expect(sql).not.toMatch(/END \$(?!\$)/);
    expect((sql.match(/\$\$/g) ?? []).length % 2).toBe(0);
  });

  it("only touches storage.buckets when that table exists", () => {
    const at = sql.indexOf("UPDATE storage.buckets");
    expect(at).toBeGreaterThan(0);
    expect(sql.slice(0, at)).toMatch(/IF to_regclass\('storage\.buckets'\) IS NOT NULL THEN\s*$/);
  });

  it("drops each policy before creating it, so it can be run again", () => {
    for (const m of sql.matchAll(/^CREATE POLICY (\w+) ON (\S+)/gm)) {
      expect(sql).toContain(`DROP POLICY IF EXISTS ${m[1]} ON ${m[2]};`);
    }
  });
});
