import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { REGISTER_SELECT } from './platform/records-data'

// A column name that is not on the table makes the whole query fail, and the code that reads the result usually treats that as "no rows"
// ("Incident not found", an empty Reports page). tsc and the unit tests cannot see it, so this reads the migrations: every plain column named in a
// query on incidents must appear in them.

const root = process.cwd()
const migrations = readdirSync(path.join(root, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(path.join(root, 'supabase/migrations', f), 'utf8'))
  .join('\n')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p)
  }
  return out
}

function columnsOf(list: string): string[] {
  return list
    .split(',')
    .map((c) => c.trim())
    .filter((c) => /^[a-z_][a-z0-9_]*$/.test(c))
}

describe('queries on the incidents table name real columns', () => {
  const found: { file: string; column: string }[] = []
  for (const dir of ['src/app/api/incidents', 'src/lib/incidents']) {
    for (const file of walk(path.join(root, dir))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\.from\((["'])incidents\1\)\s*\.select\((["'])([^"']*)\2/g)) {
        for (const column of columnsOf(m[3])) found.push({ file: path.relative(root, file), column })
      }
    }
  }
  for (const column of columnsOf(REGISTER_SELECT)) found.push({ file: 'records-data.ts (REGISTER_SELECT)', column })

  it('found queries to check', () => {
    expect(found.length).toBeGreaterThan(20)
  })

  it('every column appears in a migration', () => {
    const missing = found.filter(({ column }) => !new RegExp(String.raw`\b${column}\b`).test(migrations))
    expect(missing).toEqual([])
  })
})
