// ============================================================
// The shipped lists as SQL for migration 163: the function `sign_option_list_defaults()`, whose rows are generated from
// system-lists.ts so there is one source. `migration.test.ts` fails when the block between the markers in the
// migration file differs from what this makes; `UPDATE_LISTS_MIGRATION=1 npx vitest run src/lib/sign/lists/migration`
// rewrites the block.
//
// It is a function (not a table) because it is product data, not tenant data: no account, nothing to export or delete
// with a workspace, nothing for an API role to read. A later change to a shipped list is a new migration that replaces the
// function with a higher `version`; workspaces keep their own copy (the admin presses "Reset to default" where they want it).
// ============================================================

import { SYSTEM_LISTS } from "./system-lists";

export const BEGIN_MARKER = "-- BEGIN GENERATED: sign_option_list_defaults (src/lib/sign/lists/migration-sql.ts)";
export const END_MARKER = "-- END GENERATED: sign_option_list_defaults";

const text = (s: string): string => `'${s.replace(/'/g, "''")}'::text`;

export function systemListsSql(): string {
  const rows = SYSTEM_LISTS.map((l) => {
    const json = JSON.stringify(l.items);
    if (json.includes("$j$") || json.includes("$f$")) throw new Error(`list ${l.key} contains a dollar-quote tag`);
    return `  (${text(l.key)}, ${text(l.name)}, ${text(l.description)}, ${text(l.kind)}, $j$${json}$j$::jsonb, ${l.version}::integer, ${l.position}::integer)`;
  });
  return [
    BEGIN_MARKER,
    "CREATE OR REPLACE FUNCTION public.sign_option_list_defaults()",
    "RETURNS TABLE (key TEXT, name TEXT, description TEXT, kind TEXT, items JSONB, version INTEGER, sort_order INTEGER)",
    "LANGUAGE sql",
    "IMMUTABLE",
    "SET search_path = public",
    "AS $f$",
    "  SELECT * FROM (VALUES",
    rows.join(",\n"),
    "  ) AS v (key, name, description, kind, items, version, sort_order)",
    "$f$;",
    "REVOKE ALL ON FUNCTION public.sign_option_list_defaults() FROM PUBLIC, anon, authenticated;",
    "GRANT EXECUTE ON FUNCTION public.sign_option_list_defaults() TO service_role;",
    END_MARKER,
  ].join("\n");
}
