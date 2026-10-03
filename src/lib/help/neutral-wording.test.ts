import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Help pages are read by every customer workspace, so they must not name the company that runs the platform.
// The Jira and incident pages are for the platform owner's own workspace (those modules are switched off for customers).
const OWNER_ONLY = ['incidents', 'jira-link.md']

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? markdownFiles(path) : path.endsWith('.md') ? [path] : []
  })
}

describe('help wording', () => {
  it('does not name Vircle in pages every customer can read', () => {
    const files = markdownFiles(join(process.cwd(), 'content', 'help')).filter((f) => !OWNER_ONLY.some((o) => f.includes(o)))
    expect(files.length).toBeGreaterThan(10)
    const offenders = files.filter((f) => /vircle/i.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
