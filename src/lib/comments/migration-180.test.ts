import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guards on the text of migration 180 (the Comments inbox grouped by post). The behaviour itself is proven against a database by
// supabase/ci/verify-180-comment-post-threads.sql; these checks only stop a later edit from quietly undoing the design:
// nothing SECURITY DEFINER (so row level security decides what is visible and no guard-catalog allowlist entry is needed), no access for
// signed-out callers, and a person's seen rows tied to that person.

const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', '180_comment_post_threads.sql'), 'utf8')
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

describe('migration 180', () => {
  it('adds no SECURITY DEFINER function: both functions run as the caller', () => {
    expect(code).not.toMatch(/SECURITY\s+DEFINER/i)
    expect(code.match(/SECURITY INVOKER/g)).toHaveLength(2)
    expect(code.match(/SET search_path = public/g)).toHaveLength(2)
  })

  it('takes the person from auth.uid(), never from a parameter', () => {
    expect(code).not.toMatch(/p_user/i)
    expect(code).toContain('auth.uid()')
  })

  it('keeps signed-out callers out of the table and both functions', () => {
    expect(code).toMatch(/REVOKE ALL ON public\.comment_post_reads FROM PUBLIC, anon/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.comment_posts_inbox\([^)]*\) FROM PUBLIC, anon/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.comment_post_mark_seen\(UUID\) FROM PUBLIC, anon/)
    expect(code).not.toMatch(/GRANT[^;]*\bTO[^;]*\banon\b/)
  })

  it('turns row level security on and ties every policy to the signed-in person', () => {
    expect(code).toMatch(/ALTER TABLE public\.comment_post_reads ENABLE ROW LEVEL SECURITY/)
    const policies = code.match(/CREATE POLICY comment_post_reads_\w+/g) ?? []
    expect(policies).toHaveLength(4)
    const body = code.slice(code.indexOf('CREATE POLICY comment_post_reads_select'), code.indexOf('CREATE OR REPLACE FUNCTION public.comment_posts_inbox'))
    expect((body.match(/user_id = \(SELECT auth\.uid\(\)\)/g) ?? []).length).toBe(5)
    expect(body).not.toMatch(/USING\s*\(\s*true\s*\)/i)
  })

  it('is idempotent', () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.comment_post_reads/)
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS comments_account_post_idx/)
    expect(code.match(/DROP POLICY IF EXISTS/g)).toHaveLength(4)
    expect(code.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(2)
  })

  it('cascades the seen rows with the workspace, the person and the post', () => {
    expect(code).toMatch(/REFERENCES public\.accounts\(id\) ON DELETE CASCADE/)
    expect(code).toMatch(/REFERENCES auth\.users\(id\) ON DELETE CASCADE/)
    expect(code).toMatch(/REFERENCES public\.comment_posts\(id\) ON DELETE CASCADE/)
  })
})
