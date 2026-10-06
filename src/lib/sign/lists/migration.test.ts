import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BEGIN_MARKER, END_MARKER, systemListsSql } from "./migration-sql";
import { SYSTEM_LISTS } from "./system-lists";

// Migration 163 carries the shipped lists as generated SQL. This test keeps the migration and system-lists.ts in step:
// it fails when they differ, and UPDATE_LISTS_MIGRATION=1 rewrites the block (run it after changing a list).

const FILE = path.join(process.cwd(), "supabase", "migrations", "163_sign_option_lists.sql");

function block(text: string): { from: number; to: number } {
  const from = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (from < 0 || end < 0) throw new Error("the generated block markers are missing from migration 163");
  return { from, to: end + END_MARKER.length };
}

describe("migration 163 carries the shipped lists", () => {
  it("has the generated block, up to date", () => {
    const original = readFileSync(FILE, "utf8");
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const text = original.replace(/\r\n/g, "\n");
    const { from, to } = block(text);
    const wanted = systemListsSql();
    if (process.env.UPDATE_LISTS_MIGRATION === "1" && text.slice(from, to) !== wanted) {
      writeFileSync(FILE, (text.slice(0, from) + wanted + text.slice(to)).replace(/\n/g, eol), "utf8");
      return;
    }
    expect(text.slice(from, to)).toBe(wanted);
  });

  it("is a safe statement: every list is dollar-quoted JSON that parses back to the same items", () => {
    const sql = systemListsSql();
    for (const list of SYSTEM_LISTS) {
      const m = new RegExp(`\\('${list.key}'::text, .*?, \\$j\\$(.*?)\\$j\\$::jsonb, ${list.version}::integer, ${list.position}::integer\\)`, "s").exec(sql);
      expect(m, list.key).not.toBeNull();
      expect(JSON.parse(m![1])).toEqual(JSON.parse(JSON.stringify(list.items)));
    }
  });

  it("names only the objects the migration creates", () => {
    const text = readFileSync(FILE, "utf8");
    for (const needle of ["sign_option_list_defaults", "sign_option_lists", "sign_seed_option_lists", "sign_option_lists_guard"]) expect(text).toContain(needle);
  });
});
