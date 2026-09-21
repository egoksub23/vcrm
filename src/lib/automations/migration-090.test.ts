import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Static checks on migration 090 and its verify script. The behaviour itself is
// proved in the database by supabase/ci/verify-090-automation-ai.sql (a rolled
// back run); these guard the shape so a later edit cannot quietly weaken it.

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const DRAFT = 'supabase/ci/drafts/090_automation_ai.sql'
const MIGRATION = 'supabase/migrations/090_automation_ai.sql'
const VERIFY = 'supabase/ci/verify-090-automation-ai.sql'

describe('migration 090_automation_ai', () => {
  const sql = read(DRAFT)

  it('widens the routing and usage-log CHECKs from their live definitions, not from a hard-coded list', () => {
    expect(sql).toContain('pg_get_constraintdef')
    expect(sql).toContain("'public.ai_task_routing'")
    expect(sql).toContain("'public.ai_usage_log'")
    expect(sql).toMatch(/'closing_note',\s+'automation'/)
    // No hard-coded rebuild of the list (that is what loses values other migrations added).
    expect(sql).not.toMatch(/CHECK \(\s*(task|mode) IN \(/)
  })

  it('is idempotent: a value already listed is skipped, and only ADD CONSTRAINT / OR REPLACE are used', () => {
    expect(sql).toMatch(/CONTINUE;\s+-- already accepted/)
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.next_ticket_number_system')
    expect(sql).not.toMatch(/DROP TABLE|DROP FUNCTION|TRUNCATE|DELETE FROM/i)
  })

  it('widens the trigger and step types only if a database constrains them (live: they are free text)', () => {
    expect(sql).toContain("'conversation_closed'")
    expect(sql).toContain("'ai_reply'")
    expect(sql).toContain("'create_ticket'")
  })

  it('the ticket number for automations is executable by the service role only', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.next_ticket_number_system\(uuid\) FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.next_ticket_number_system\(uuid\) TO service_role/)
    // It must not touch the people-facing function (088).
    expect(sql).not.toMatch(/REPLACE FUNCTION public\.next_ticket_number\(/)
  })

  it('uses the same counter as the ticket dialog', () => {
    expect(sql).toContain('UPDATE accounts SET ticket_seq = ticket_seq + 1')
  })

  it('once applied, the copy in supabase/migrations is the draft, byte for byte', () => {
    if (!existsSync(join(process.cwd(), MIGRATION))) return // still a draft
    expect(read(MIGRATION)).toBe(sql)
  })
})

describe('verify-090-automation-ai.sql', () => {
  const sql = read(VERIFY)

  it('is a rolled-back DO block (ends in ROLLBACK-OK)', () => {
    expect(sql).toMatch(/RAISE EXCEPTION 'ROLLBACK-OK:/)
    expect(sql).not.toMatch(/\bCOMMIT\b/i)
  })

  it('covers routing, the usage log, old values, unknown values, the trigger, tickets and the close path', () => {
    for (const needle of [
      'ai_task_routing',
      'ai_usage_log',
      "'automation'",
      "'nonsense'",
      'conversation_closed',
      'next_ticket_number_system',
      'created_by',
      'close_conversation_with_note',
    ]) {
      expect(sql, needle).toContain(needle)
    }
  })

  it('documents the run-twice idempotency check', () => {
    expect(sql).toMatch(/TWICE/)
  })
})
