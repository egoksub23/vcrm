// ============================================================
// Getting a pasted / dropped image ready to upload.
//
// A screenshot is often a 3000 px wide PNG of several MB. Before it goes to
// the chat-media bucket it is scaled down to at most 1600 px wide (never
// scaled UP), and a PNG that is still over the cap is re-encoded as a JPEG
// (WhatsApp takes JPEG and PNG as images; WebP would go out as a document).
// A GIF is never touched: it is uploaded as it is when it fits, refused with a
// clear message when it does not (re-encoding would drop the animation).
//
// The decisions are pure (`planImage`, `pastedImageName`) so they are tested
// without a browser; the canvas work sits behind a small `ImageCodec` so the
// flow itself can be tested with a fake.
// ============================================================

/** Wider than this is scaled down to it. */
export const IMAGE_MAX_WIDTH = 1600
/** Types kept as they are when they already fit. */
const PASS_THROUGH = new Set(['image/png', 'image/jpeg', 'image/webp'])
/** What a canvas can produce that the chat channels take. */
type OutType = 'image/png' | 'image/jpeg'

export type ImageProblem = 'unsupported' | 'tooLarge' | 'decode'

/** A pasted image that cannot be used, with a code the UI turns into text. */
export class ImagePrepareError extends Error {
  constructor(
    public readonly code: ImageProblem,
    public readonly maxBytes?: number,
  ) {
    super(code)
    this.name = 'ImagePrepareError'
  }
}

/** Only images are accepted here: everything else is not our business. */
export function isImageType(type: string): boolean {
  return type.toLowerCase().startsWith('image/')
}

/** The size to draw at: never wider than `maxWidth`, never larger than the
 *  original, aspect ratio kept. */
export function fitWidth(
  width: number,
  height: number,
  maxWidth: number = IMAGE_MAX_WIDTH,
): { width: number; height: number; scaled: boolean } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0, scaled: false }
  if (width <= maxWidth) return { width, height, scaled: false }
  const ratio = maxWidth / width
  return { width: maxWidth, height: Math.max(1, Math.round(height * ratio)), scaled: true }
}

const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** "pasted-image-20260920-143012.png": the file name for an image that has
 *  none of its own worth keeping (a clipboard image is always "image.png"). */
export function pastedImageName(type: string, now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `pasted-image-${stamp}.${EXTENSION[type.toLowerCase()] ?? 'png'}`
}

/** True for the placeholder names browsers give clipboard images. */
export function isGenericImageName(name: string): boolean {
  return !name || /^(image|blob|untitled|screenshot)?\.?(png|jpe?g|gif|webp)?$/i.test(name.trim())
}

/** The same name with the extension of `type`. */
export function renameForType(name: string, type: string): string {
  const ext = EXTENSION[type.toLowerCase()]
  if (!ext) return name
  const base = name.replace(/\.[^.]+$/, '')
  return `${base || 'image'}.${ext}`
}

export interface ImagePlan {
  /** Upload the file untouched. */
  keep: boolean
}

/** Whether the file can go up as it is: a GIF that fits, or a PNG / JPEG /
 *  WebP that is narrow enough and fits the cap. */
export function planImage(
  file: { type: string; size: number },
  width: number,
  maxBytes: number,
  maxWidth: number = IMAGE_MAX_WIDTH,
): ImagePlan {
  const type = file.type.toLowerCase()
  if (type === 'image/gif') return { keep: true }
  return { keep: PASS_THROUGH.has(type) && width <= maxWidth && file.size <= maxBytes }
}

// ---- The browser half ---------------------------------------------------

export interface DecodedImage {
  width: number
  height: number
  /** Draws the image scaled to the given size onto a fresh canvas and encodes
   *  it. `background` fills first (JPEG has no transparency). */
  encode(
    width: number,
    height: number,
    type: OutType,
    quality: number,
    background: string | null,
  ): Promise<Blob | null>
  close(): void
}

export interface ImageCodec {
  decode(file: Blob): Promise<DecodedImage>
}

/** The real thing: createImageBitmap plus a canvas. */
export const browserCodec: ImageCodec = {
  async decode(file) {
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(file)
    } catch {
      throw new ImagePrepareError('decode')
    }
    return {
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
      encode(width, height, type, quality, background) {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) return Promise.resolve(null)
        ctx.imageSmoothingQuality = 'high'
        if (background) {
          ctx.fillStyle = background
          ctx.fillRect(0, 0, width, height)
        }
        ctx.drawImage(bitmap, 0, 0, width, height)
        return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
      },
    }
  },
}

/** Attempts after the first, in order: keep the type as long as it can fit,
 *  then JPEG at falling quality and, last, at a smaller width. */
function attempts(type: string, width: number): { type: OutType; quality: number; width: number }[] {
  const list: { type: OutType; quality: number; width: number }[] = []
  if (type === 'image/png') list.push({ type: 'image/png', quality: 1, width })
  list.push({ type: 'image/jpeg', quality: 0.85, width })
  list.push({ type: 'image/jpeg', quality: 0.7, width })
  for (const w of [1200, 900, 640]) {
    if (w < width) list.push({ type: 'image/jpeg', quality: 0.7, width: w })
  }
  return list
}

export interface PrepareOptions {
  maxBytes: number
  maxWidth?: number
  codec?: ImageCodec
  now?: Date
}

/**
 * The file to upload for a pasted / dropped image. Throws `ImagePrepareError`
 * ('unsupported' for something that is not an image the chat channels can
 * carry, 'tooLarge' when it cannot be brought under `maxBytes`, 'decode' when
 * the browser cannot read it).
 */
export async function prepareImageForUpload(file: File, opts: PrepareOptions): Promise<File> {
  const type = file.type.toLowerCase()
  if (!isImageType(type)) throw new ImagePrepareError('unsupported')
  const name = isGenericImageName(file.name) ? pastedImageName(type, opts.now) : file.name
  const maxWidth = opts.maxWidth ?? IMAGE_MAX_WIDTH

  if (type === 'image/gif') {
    if (file.size > opts.maxBytes) throw new ImagePrepareError('tooLarge', opts.maxBytes)
    return name === file.name ? file : new File([file], name, { type })
  }

  const codec = opts.codec ?? browserCodec
  const decoded = await codec.decode(file)
  try {
    if (planImage(file, decoded.width, opts.maxBytes, maxWidth).keep) {
      return name === file.name ? file : new File([file], name, { type })
    }
    const fit = fitWidth(decoded.width, decoded.height, maxWidth)
    for (const attempt of attempts(type, fit.width)) {
      const size = fitWidth(fit.width, fit.height, attempt.width)
      const blob = await decoded.encode(
        size.width,
        size.height,
        attempt.type,
        attempt.quality,
        attempt.type === 'image/jpeg' ? '#ffffff' : null,
      )
      if (blob && blob.size > 0 && blob.size <= opts.maxBytes) {
        // A PNG small enough that was only scaled down stays a PNG.
        return new File([blob], renameForType(name, attempt.type), { type: attempt.type })
      }
    }
    throw new ImagePrepareError('tooLarge', opts.maxBytes)
  } finally {
    decoded.close()
  }
}
