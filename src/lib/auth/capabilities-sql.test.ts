import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CAPABILITIES, DEFAULT_CAPABILITIES } from "./capabilities";
import { ACCOUNT_ROLES } from "./roles";

// Migration 079 seeds `capability_catalogue` and `role_capability_defaults`
// from the TypeScript catalogue. This test parses the seed out of the
// migration text and fails if the SQL mirror and the TS source of truth
// ever disagree (someone edited one without the other).

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "079_role_capabilities.sql"),
  "utf8",
);

function seedRows(insertHeader: string): string[][] {
  const start = migration.indexOf(insertHeader);
  expect(start, `seed for ${insertHeader} not found`).toBeGreaterThan(-1);
  const end = migration.indexOf(";", start);
  const body = migration.slice(start, end);
  const rows: string[][] = [];
  for (const m of body.matchAll(/\(\s*('[^']*'(?:\s*,\s*'[^']*')*)\s*\)/g)) {
    rows.push([...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]));
  }
  return rows;
}

describe("migration 079 mirrors the TS catalogue", () => {
  it("seeds the catalogue with the same keys, min grant role and tier", () => {
    const rows = seedRows(
      "INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES",
    );
    const sql = new Map(rows.map(([cap, min, tier]) => [cap, { min, tier }]));
    expect(sql.size).toBe(CAPABILITIES.length);
    for (const c of CAPABILITIES) {
      expect(sql.get(c.key), c.key).toEqual({
        min: c.minGrantRole,
        tier: c.enforcedBy,
      });
    }
  });

  it("seeds the defaults with exactly the TS default sets", () => {
    const rows = seedRows(
      "INSERT INTO public.role_capability_defaults (role, capability) VALUES",
    );
    const byRole = new Map<string, Set<string>>();
    for (const [role, cap] of rows) {
      if (!byRole.has(role)) byRole.set(role, new Set());
      byRole.get(role)!.add(cap);
    }
    for (const role of ACCOUNT_ROLES) {
      expect([...(byRole.get(role) ?? [])].sort(), role).toEqual(
        [...DEFAULT_CAPABILITIES[role]].sort(),
      );
    }
    expect(rows.length).toBe(
      ACCOUNT_ROLES.reduce((n, r) => n + DEFAULT_CAPABILITIES[r].size, 0),
    );
  });

  it("only moves the database-tier policies to has_capability", () => {
    // Every capability marked 'database' in TS must actually be used by
    // has_capability() in the migration (RLS policy or RPC).
    const seedStart = migration.indexOf("-- Seed: catalogue + defaults");
    const seedEnd = migration.indexOf("-- RLS on the new tables");
    expect(seedStart).toBeGreaterThan(-1);
    expect(seedEnd).toBeGreaterThan(seedStart);
    const withoutSeed = migration.slice(0, seedStart) + migration.slice(seedEnd);
    for (const c of CAPABILITIES.filter((x) => x.enforcedBy === "database")) {
      expect(
        withoutSeed.includes(`'${c.key}'`),
        `${c.key} is marked database-enforced but 079 never checks it`,
      ).toBe(true);
    }
  });
});
