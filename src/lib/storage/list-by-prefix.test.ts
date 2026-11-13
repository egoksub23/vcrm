import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listObjectsByPrefix } from './list-by-prefix'

const A = 'aaaaaaaa-1111-2222-3333-444444444444'
const B = 'bbbbbbbb-1111-2222-3333-444444444444'

let root: string
const saved = { provider: process.env.STORAGE_PROVIDER, path: process.env.STORAGE_FILEPATH }

function put(rel: string) {
  const full = path.join(root, rel)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, 'x')
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'halo-list-'))
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

describe('listObjectsByPrefix (filesystem)', () => {
  it("lists one workspace's files in every bucket, nested folders included, sorted", async () => {
    put(`sign-files/account-${A}/doc.pdf`)
    put(`chat-media/account-${A}/widget/c1/photo.png`)
    put(`chat-media/account-${A}/a.bin`)
    put(`chat-media/account-${B}/other.bin`)
    put('avatars/someone.png')
    expect(await listObjectsByPrefix(`account-${A}/`)).toEqual([
      { bucket: 'chat-media', name: `account-${A}/a.bin` },
      { bucket: 'chat-media', name: `account-${A}/widget/c1/photo.png` },
      { bucket: 'sign-files', name: `account-${A}/doc.pdf` },
    ])
  })

  it("finds a person's avatar folder", async () => {
    put(`avatars/${A}/avatar.png`)
    put(`avatars/${B}/avatar.png`)
    expect(await listObjectsByPrefix(`${A}/`)).toEqual([{ bucket: 'avatars', name: `${A}/avatar.png` }])
  })

  it('is empty when the workspace has nothing stored, or nothing was ever stored', async () => {
    put(`chat-media/account-${B}/other.bin`)
    expect(await listObjectsByPrefix(`account-${A}/`)).toEqual([])
    process.env.STORAGE_FILEPATH = path.join(root, 'never-created')
    expect(await listObjectsByPrefix(`account-${A}/`)).toEqual([])
  })

  it('refuses a prefix that could list a whole bucket or leave the store', async () => {
    await expect(listObjectsByPrefix('')).rejects.toThrow(/refusing/)
    await expect(listObjectsByPrefix('account-')).rejects.toThrow(/refusing/)
    await expect(listObjectsByPrefix(`../${A}/`)).rejects.toThrow(/refusing/)
    await expect(listObjectsByPrefix(`/account-${A}/`)).rejects.toThrow(/refusing/)
  })

  it('refuses to guess without a storage provider', async () => {
    delete process.env.STORAGE_PROVIDER
    await expect(listObjectsByPrefix(`account-${A}/`)).rejects.toThrow(/STORAGE_PROVIDER/)
  })
})
