import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { SCHOOL_WEBHOOK_EVENTS as fromServer } from './school-webhooks'
import { SCHOOL_WEBHOOK_EVENTS } from './school-webhook-types'

describe('school webhook types', () => {
  it('imports nothing, so the Setup screen (a client component) never pulls the database driver into the browser', () => {
    const text = readFileSync(path.join(__dirname, 'school-webhook-types.ts'), 'utf8')
    expect(text).not.toMatch(/^\s*import\s/m)
  })

  it('the server module still exports the same list', () => {
    expect(fromServer).toBe(SCHOOL_WEBHOOK_EVENTS)
  })
})
