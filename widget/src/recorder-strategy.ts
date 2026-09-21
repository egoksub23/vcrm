// ============================================================
// Voice-note recording: which encoders to try, and in what order.
// Pure (no DOM) so the fallback logic is unit-tested with mocks.
//
// The chat-media bucket only accepts Meta-friendly audio types
// (ogg, mpeg, aac, mp4, amr, opus) — NOT the audio/webm that Chrome's
// MediaRecorder produces. So the primary path is the same in-browser
// Ogg/Opus encoder the CRM composer uses (opus-recorder, lazy-loaded
// from the API origin); MediaRecorder is only a fallback where the
// browser can natively emit an allowed type (Firefox: audio/ogg,
// Safari: audio/mp4).
// ============================================================
import { baseMime } from './util'

export type Strategy = { kind: 'opus' } | { kind: 'mediarecorder'; mime: string }

export interface RecorderEnv {
  hasGetUserMedia: boolean
  hasAudioContext: boolean
  hasWorker: boolean
  hasMediaRecorder: boolean
  isTypeSupported: (mime: string) => boolean
}

/** Candidate MediaRecorder types, best first. */
export const MEDIARECORDER_CANDIDATES = [
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/aac',
]

/**
 * Ordered list of strategies worth trying in this browser. Empty means
 * voice notes cannot be produced in an allowed format here and the mic
 * button should not be offered.
 */
export function planStrategies(env: RecorderEnv, allowedMimes: string[]): Strategy[] {
  if (!env.hasGetUserMedia) return []
  const allowed = allowedMimes.map(baseMime)
  const plans: Strategy[] = []
  if (env.hasAudioContext && env.hasWorker && allowed.includes('audio/ogg')) {
    plans.push({ kind: 'opus' })
  }
  if (env.hasMediaRecorder) {
    for (const mime of MEDIARECORDER_CANDIDATES) {
      if (!allowed.includes(baseMime(mime))) continue
      if (!env.isTypeSupported(mime)) continue
      plans.push({ kind: 'mediarecorder', mime })
      break
    }
  }
  return plans
}

export type VoiceErrorCode = 'denied' | 'unsupported' | 'failed'

export class VoiceError extends Error {
  code: VoiceErrorCode
  constructor(code: VoiceErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'VoiceError'
    this.code = code
  }
}

/** Microphone refusals must not trigger the next strategy (it would just prompt again). */
export function isPermissionError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? ''
  return name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError'
}

export interface VoiceResult {
  blob: Blob
  /** Base MIME type, no codec parameters (e.g. "audio/ogg"). */
  mimeType: string
  durationSeconds: number
}

export interface VoiceHandle {
  /** Finish the take and return the encoded audio. */
  stop(): Promise<VoiceResult>
  /** Throw the take away and release the microphone. */
  cancel(): void
  /** Live input level 0..1 when the strategy can measure it. */
  getLevel?: () => number
  /** Silence detection (only when the strategy can measure the input). */
  getSignal?: () => { maxPeak: number; showHint: boolean }
  /** The input device actually in use (deviceId), when the browser reports it. */
  deviceId?: string | null
}

/**
 * Try each strategy in order until one starts. A permission refusal
 * stops the chain immediately; any other failure moves on to the next
 * strategy. Throws VoiceError('unsupported') when there is nothing to
 * try and VoiceError('failed') when everything failed.
 */
export async function startWithFallback(
  plans: Strategy[],
  start: (plan: Strategy) => Promise<VoiceHandle>,
): Promise<VoiceHandle> {
  if (plans.length === 0) throw new VoiceError('unsupported')
  let last: unknown = null
  for (const plan of plans) {
    try {
      return await start(plan)
    } catch (err) {
      if (isPermissionError(err)) throw new VoiceError('denied')
      last = err
    }
  }
  throw new VoiceError('failed', last instanceof Error ? last.message : undefined)
}
