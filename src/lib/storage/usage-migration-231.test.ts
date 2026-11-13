import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  path.join(process.cwd(), 'supabase/migrations/231_usage_storage_from_app.sql'),
  'utf8',
).replace(/\r\n/g, '\n')
// The SQL without its comments, which talk about storage.objects on purpose.
const code = sql.replace(/--.*$/gm, '')

describe('migration 231 (usage job no longer reads storage.objects)', () => {
  it('does not touch Supabase storage any more', () => {
    expect(code).not.toMatch(/storage\.objects/)
  })

  it('replaces the one-argument job with one that takes the measured storage', () => {
    expect(code).toMatch(/DROP FUNCTION IF EXISTS public\.usage_snapshot_run\(INTEGER\)/)
    expect(code).toMatch(/usage_snapshot_run\(\s*p_limit\s+INTEGER DEFAULT 200,\s*p_storage\s+JSONB\s+DEFAULT NULL/)
  })

  it('keeps the last known figure when nothing was measured', () => {
    expect(code).toMatch(/WHEN p_storage IS NULL THEN[\s\S]*account_usage_daily x[\s\S]*ORDER BY x\.day DESC LIMIT 1/)
    expect(code).toMatch(/p_storage ->> r\.id::text/)
  })

  it('can only be run by the service role', () => {
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.usage_snapshot_run\(INTEGER, JSONB\) FROM PUBLIC, anon, authenticated/)
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.usage_snapshot_run\(INTEGER, JSONB\) TO service_role/)
  })
})
