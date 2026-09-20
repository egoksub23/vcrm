import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Test helper: the text of a migration. A migration that is still being
 * drafted lives in `supabase/ci/drafts/` (so `supabase db push` cannot apply
 * it by accident) and is copied to `supabase/migrations/` when it ships; the
 * tests read whichever exists, migrations first.
 */
export function readMigration(file: string): string {
  const applied = join(process.cwd(), "supabase", "migrations", file);
  const draft = join(process.cwd(), "supabase", "ci", "drafts", file);
  return readFileSync(existsSync(applied) ? applied : draft, "utf8");
}
