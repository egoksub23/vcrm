import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { accountOfPath, measureAccountStorage } from './usage-measure'

const A = 'aaaaaaaa-1111-2222-3333-444444444444'
const B = 'bbbbbbbb-1111-2222-3333-444444444444'

let root: string
const saved = { provider: process.env.STORAGE_PROVIDER, path: process.env.STORAGE_FILEPATH }

function put(rel: string, bytes: number) {
  const full = path.join(root, rel)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, Buffer.alloc(bytes, 1))
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'halo-usage-'))
  process.env.STORAGE_PROVIDER = 'filesystem'
  process.env.STORAGE_FILEPATH = root
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  if (saved.provider === undefined) delete process.env.STORAGE_PROVIDER
  else process.env.STORAGE_PROVIDER = saved.provider
  if (saved.path === undefined) delete process.env.STORAGE_FILEPATH
  else process.env.STORAGE_FILEPATH = saved.path
})

describe('accountOfPath', () => {
  it('reads the workspace id from the first folder of an object path', () => {
    expect(accountOfPath(`account-${A}/sign/doc.pdf`)).toBe(A)
    expect(accountOfPath('avatars/me.png')).toBeNull()
    expect(accountOfPath(`account-${A}`)).toBeNull()
  })
})

describe('measureAccountStorage (filesystem)', () => {
  it('adds up each workspace across every bucket and nested folder', async () => {
    put(`chat-media/account-${A}/one.bin`, 1000)
    put(`chat-media/account-${A}/deep/er/two.bin`, 500)
    put(`sign-files/account-${A}/doc.pdf`, 24)
    put(`chat-media/account-${B}/other.bin`, 7)
    expect(await measureAccountStorage()).toEqual({ [A]: 1524, [B]: 7 })
  })

  it('leaves out folders that are not a workspace, and workspaces with no files', async () => {
    put('avatars/me.png', 99)
    put('chat-media/not-an-account/x.bin', 99)
    mkdirSync(path.join(root, 'chat-media', `account-${B}`), { recursive: true })
    const out = await measureAccountStorage()
    expect(out).toEqual({ [B]: 0 })
  })

  it('does not follow a symbolic link out of the store', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'halo-outside-'))
    try {
      writeFileSync(path.join(outside, 'secret.bin'), Buffer.alloc(5000, 1))
      put(`chat-media/account-${A}/real.bin`, 10)
      try {
        symlinkSync(outside, path.join(root, 'chat-media', `account-${A}`, 'link'), 'dir')
      } catch {
        return // this machine does not allow links; nothing to prove
      }
      expect(await measureAccountStorage()).toEqual({ [A]: 10 })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('throws when the store cannot be read, so the job keeps the last figure', async () => {
    process.env.STORAGE_FILEPATH = path.join(root, 'does-not-exist')
    await expect(measureAccountStorage()).rejects.toThrow()
  })

  it('refuses to guess without a storage provider', async () => {
    delete process.env.STORAGE_PROVIDER
    await expect(measureAccountStorage()).rejects.toThrow(/STORAGE_PROVIDER/)
  })
})
