import { describe, expect, it } from 'vitest'
import {
  fitWidth,
  ImagePrepareError,
  IMAGE_MAX_WIDTH,
  isGenericImageName,
  pastedImageName,
  planImage,
  prepareImageForUpload,
  renameForType,
  type DecodedImage,
  type ImageCodec,
} from './prepare-image'

const MB = 1024 * 1024
const CAP = 5 * MB

/** A File-like stand-in with a chosen size (vitest runs in node: no real image data needed). */
function fakeFile(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type })
}

/** A codec that reports a size and produces blobs whose size follows a rule. */
function fakeCodec(
  width: number,
  height: number,
  sizeOf: (w: number, h: number, type: string, quality: number) => number,
  calls: { w: number; h: number; type: string; q: number; bg: string | null }[] = [],
): ImageCodec {
  return {
    async decode(): Promise<DecodedImage> {
      return {
        width,
        height,
        close() {},
        async encode(w, h, type, quality, background) {
          calls.push({ w, h, type, q: quality, bg: background })
          return new Blob([new Uint8Array(sizeOf(w, h, type, quality))], { type })
        },
      }
    },
  }
}

const NOW = new Date(2026, 8, 20, 14, 30, 12)

describe('fitWidth', () => {
  it('leaves a picture that is narrow enough alone and never scales up', () => {
    expect(fitWidth(800, 600)).toEqual({ width: 800, height: 600, scaled: false })
    expect(fitWidth(IMAGE_MAX_WIDTH, 900)).toEqual({ width: 1600, height: 900, scaled: false })
  })
  it('scales a wide picture down to 1600 keeping the ratio', () => {
    expect(fitWidth(3200, 1800)).toEqual({ width: 1600, height: 900, scaled: true })
    expect(fitWidth(2560, 1440)).toEqual({ width: 1600, height: 900, scaled: true })
    expect(fitWidth(1601, 1)).toEqual({ width: 1600, height: 1, scaled: true })
  })
  it('takes any other maximum', () => {
    expect(fitWidth(2000, 1000, 1000)).toEqual({ width: 1000, height: 500, scaled: true })
  })
  it('gives nothing for a broken size', () => {
    expect(fitWidth(0, 10)).toEqual({ width: 0, height: 0, scaled: false })
    expect(fitWidth(NaN, 10)).toEqual({ width: 0, height: 0, scaled: false })
  })
})

describe('names', () => {
  it('names a pasted image with a timestamp and the right extension', () => {
    expect(pastedImageName('image/png', NOW)).toBe('pasted-image-20260920-143012.png')
    expect(pastedImageName('image/jpeg', NOW)).toBe('pasted-image-20260920-143012.jpg')
    expect(pastedImageName('image/gif', NOW)).toBe('pasted-image-20260920-143012.gif')
    expect(pastedImageName('image/x-unknown', NOW)).toBe('pasted-image-20260920-143012.png')
  })
  it('knows the placeholder names a clipboard image comes with', () => {
    for (const n of ['image.png', 'Image.PNG', 'blob', '', 'untitled.jpg', 'screenshot.png']) expect(isGenericImageName(n)).toBe(true)
    for (const n of ['pricing-table.png', 'IMG_2031.jpg', 'Screenshot 2026-09-20.png']) expect(isGenericImageName(n)).toBe(false)
  })
  it('renames to the extension of the new type', () => {
    expect(renameForType('shot.png', 'image/jpeg')).toBe('shot.jpg')
    expect(renameForType('shot', 'image/png')).toBe('shot.png')
    expect(renameForType('shot.png', 'image/x-weird')).toBe('shot.png')
  })
})

describe('planImage', () => {
  it('keeps a PNG, JPEG or WebP that is narrow enough and within the cap', () => {
    expect(planImage({ type: 'image/png', size: MB }, 1200, CAP).keep).toBe(true)
    expect(planImage({ type: 'image/jpeg', size: CAP }, 1600, CAP).keep).toBe(true)
  })
  it('re-encodes one that is too wide or too big', () => {
    expect(planImage({ type: 'image/png', size: MB }, 1601, CAP).keep).toBe(false)
    expect(planImage({ type: 'image/png', size: CAP + 1 }, 800, CAP).keep).toBe(false)
  })
  it('re-encodes a type a chat channel would not take as an image', () => {
    expect(planImage({ type: 'image/bmp', size: 100 }, 100, CAP).keep).toBe(false)
  })
  it('always keeps a GIF as it is (the size check is separate)', () => {
    expect(planImage({ type: 'image/gif', size: 100 * MB }, 9000, CAP).keep).toBe(true)
  })
})

describe('prepareImageForUpload', () => {
  const opts = { maxBytes: CAP, now: NOW }

  it('returns a small screenshot untouched apart from a proper name', async () => {
    const file = fakeFile('image.png', 'image/png', 200_000)
    const calls: never[] = []
    const out = await prepareImageForUpload(file, { ...opts, codec: fakeCodec(1200, 800, () => 1, calls) })
    expect(out.name).toBe('pasted-image-20260920-143012.png')
    expect(out.type).toBe('image/png')
    expect(out.size).toBe(200_000)
    expect(calls).toHaveLength(0) // not re-encoded
  })

  it('keeps the name of a real file', async () => {
    const file = fakeFile('pricing.png', 'image/png', 1000)
    expect(await prepareImageForUpload(file, { ...opts, codec: fakeCodec(500, 500, () => 1) })).toBe(file)
  })

  it('scales a wide screenshot down to 1600 px and keeps it a PNG when that fits', async () => {
    const calls: { w: number; h: number; type: string; q: number; bg: string | null }[] = []
    const file = fakeFile('image.png', 'image/png', 3 * MB)
    const out = await prepareImageForUpload(file, { ...opts, codec: fakeCodec(3200, 1800, () => 2 * MB, calls) })
    expect(calls[0]).toMatchObject({ w: 1600, h: 900, type: 'image/png', bg: null })
    expect(out.type).toBe('image/png')
    expect(out.name.endsWith('.png')).toBe(true)
    expect(out.size).toBe(2 * MB)
  })

  it('never scales a picture up', async () => {
    const calls: { w: number; h: number; type: string; q: number; bg: string | null }[] = []
    // over the cap but only 900 px wide: re-encoded at its own size
    await prepareImageForUpload(fakeFile('a.png', 'image/png', 6 * MB), {
      ...opts,
      codec: fakeCodec(900, 600, (_w, _h, type) => (type === 'image/png' ? 6 * MB : 400_000), calls),
    })
    expect(calls.every((c) => c.w <= 900)).toBe(true)
    expect(calls[0]).toMatchObject({ w: 900, h: 600 })
  })

  it('re-encodes a PNG that is still over the cap as a white-backed JPEG at quality 0.85', async () => {
    const calls: { w: number; h: number; type: string; q: number; bg: string | null }[] = []
    const out = await prepareImageForUpload(fakeFile('image.png', 'image/png', 9 * MB), {
      ...opts,
      codec: fakeCodec(3000, 2000, (_w, _h, type) => (type === 'image/png' ? 7 * MB : 900_000), calls),
    })
    expect(calls.map((c) => c.type)).toEqual(['image/png', 'image/jpeg'])
    expect(calls[1]).toMatchObject({ q: 0.85, bg: '#ffffff', w: 1600 })
    expect(out.type).toBe('image/jpeg')
    expect(out.name).toBe('pasted-image-20260920-143012.jpg')
    expect(out.size).toBe(900_000)
  })

  it('tries lower quality, then a smaller width, before giving up', async () => {
    const calls: { w: number; h: number; type: string; q: number; bg: string | null }[] = []
    const out = await prepareImageForUpload(fakeFile('a.jpg', 'image/jpeg', 30 * MB), {
      ...opts,
      // only fits once it is 1200 px wide
      codec: fakeCodec(4000, 3000, (w) => (w <= 1200 ? 3 * MB : 8 * MB), calls),
    })
    expect(calls.map((c) => `${c.w}@${c.q}`)).toEqual(['1600@0.85', '1600@0.7', '1200@0.7'])
    expect(out.size).toBe(3 * MB)
  })

  it('refuses a picture it cannot bring under the cap, saying what the cap is', async () => {
    const err = await prepareImageForUpload(fakeFile('a.png', 'image/png', 50 * MB), {
      ...opts,
      codec: fakeCodec(4000, 3000, () => 20 * MB),
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImagePrepareError)
    expect(err).toMatchObject({ code: 'tooLarge', maxBytes: CAP })
  })

  it('uploads a GIF as it is, without decoding it', async () => {
    const calls: never[] = []
    const gif = fakeFile('loop.gif', 'image/gif', 2 * MB)
    const codec: ImageCodec = {
      decode: async () => {
        throw new Error('a GIF must not be decoded')
      },
    }
    expect(await prepareImageForUpload(gif, { ...opts, codec })).toBe(gif)
    expect(calls).toHaveLength(0)
  })

  it('names a generic GIF sensibly', async () => {
    const out = await prepareImageForUpload(fakeFile('image.gif', 'image/gif', 1000), opts)
    expect(out.name).toBe('pasted-image-20260920-143012.gif')
    expect(out.type).toBe('image/gif')
  })

  it('refuses a GIF over the cap with a clear reason (re-encoding would drop the animation)', async () => {
    const err = await prepareImageForUpload(fakeFile('big.gif', 'image/gif', 6 * MB), opts).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'tooLarge', maxBytes: CAP })
  })

  it('refuses anything that is not an image', async () => {
    const err = await prepareImageForUpload(fakeFile('a.pdf', 'application/pdf', 100), opts).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'unsupported' })
  })

  it('passes on a picture the browser cannot read', async () => {
    const codec: ImageCodec = {
      decode: async () => {
        throw new ImagePrepareError('decode')
      },
    }
    const err = await prepareImageForUpload(fakeFile('a.heic', 'image/heic', 100), { ...opts, codec }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'decode' })
  })

  it('always releases the decoded picture', async () => {
    let closed = 0
    const codec: ImageCodec = {
      decode: async () => ({ width: 4000, height: 3000, close: () => void closed++, encode: async () => null }),
    }
    await prepareImageForUpload(fakeFile('a.png', 'image/png', 9 * MB), { ...opts, codec }).catch(() => {})
    expect(closed).toBe(1)
  })

  it('treats an encoder that returns nothing as a failed attempt', async () => {
    const codec: ImageCodec = {
      decode: async () => ({
        width: 3000,
        height: 2000,
        close() {},
        encode: async (_w, _h, type) => (type === 'image/png' ? null : new Blob([new Uint8Array(1000)], { type })),
      }),
    }
    const out = await prepareImageForUpload(fakeFile('image.png', 'image/png', 9 * MB), { ...opts, codec })
    expect(out.type).toBe('image/jpeg')
  })
})
