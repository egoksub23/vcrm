// Global mock for @/lib/storage/provider.
//
// Sign and compliance tests call appStorage() but do not connect to a real
// MinIO instance. This setup file replaces appStorage() with an in-memory
// implementation so every test that calls it gets fake storage that works
// without any infrastructure.
//
// FakeDb (src/lib/sign/service/fake-db.ts) also exposes a `files` Map on its
// instances so tests can read what was stored. We share ONE Map via
// globalThis.__mockStorageFiles__ so FakeDb.files and this mock point to the
// same object, and t.db.files.get(path) finds what appStorage().upload wrote.
//
// Loaded via vitest.config.ts setupFiles so the mock is in place before any
// test module imports lib/sign/storage or anything that calls appStorage().

import { vi, beforeEach } from 'vitest'

// Shared map: FakeDb's constructor reads this too (fake-db.ts).
const files: Map<string, Uint8Array> = new Map()
;(globalThis as Record<string, unknown>).__mockStorageFiles__ = files

vi.mock('@/lib/storage/provider', () => {
  const bucket = () => ({
    upload: async (
      path: string,
      data: Uint8Array | Buffer | Blob | File,
      _opts?: unknown,
    ) => {
      let arr: Uint8Array
      if (data instanceof Blob) {
        arr = new Uint8Array(await data.arrayBuffer())
      } else {
        arr = new Uint8Array(data as Uint8Array)
      }
      files.set(path, arr)
      return { data: { path }, error: null }
    },
    download: async (path: string) => {
      const b = files.get(path)
      if (!b) return { data: null, error: { message: 'Object not found' } }
      return { data: new Blob([b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer]), error: null }
    },
    copy: async (from: string, to: string) => {
      const b = files.get(from)
      if (!b) return { data: null, error: { message: 'Object not found' } }
      files.set(to, new Uint8Array(b))
      return { data: { path: to }, error: null }
    },
    remove: async (paths: string[]) => {
      for (const p of paths) files.delete(p)
      return { data: [], error: null }
    },
    getPublicUrl: (path: string) => ({
      data: { publicUrl: `https://test.example/${path}` },
    }),
    list: async (_prefix: string) => ({ data: [], error: null }),
    createSignedUrl: async (path: string, _expiresIn: number) => ({
      data: { signedUrl: `https://test.example/signed/${path}` },
      error: null,
    }),
  })

  return {
    appStorage: () => ({ from: (_name: string) => bucket() }),
  }
})

beforeEach(() => {
  files.clear()
})
