// ============================================================
// Core-bundle side of voice notes: decides what this browser can do,
// loads the Opus recorder chunk on demand, and falls back to a native
// MediaRecorder where that already yields an allowed audio type.
// ============================================================
import { loadRecorderChunk } from './lazy'
import { activeMicrophoneId, createLevelMonitor, openMicrophone, type LevelMonitor } from './mic'
import {
  planStrategies,
  startWithFallback,
  VoiceError,
  type RecorderEnv,
  type Strategy,
  type VoiceHandle,
  type VoiceResult,
} from './recorder-strategy'
import { baseMime } from './util'

export function detectRecorderEnv(): RecorderEnv {
  const w = window as unknown as {
    AudioContext?: unknown
    webkitAudioContext?: unknown
    MediaRecorder?: { isTypeSupported?: (m: string) => boolean }
  }
  const hasMediaRecorder = typeof w.MediaRecorder === 'function'
  return {
    hasGetUserMedia: !!navigator.mediaDevices?.getUserMedia,
    hasAudioContext: !!(w.AudioContext ?? w.webkitAudioContext),
    hasWorker: typeof Worker !== 'undefined' && typeof URL?.createObjectURL === 'function',
    hasMediaRecorder,
    isTypeSupported: (m) => {
      try {
        return hasMediaRecorder && !!w.MediaRecorder?.isTypeSupported?.(m)
      } catch {
        return false
      }
    },
  }
}

/** Whether to offer the microphone button at all in this browser. */
export function canRecordVoice(allowedMimes: string[]): boolean {
  return planStrategies(detectRecorderEnv(), allowedMimes).length > 0
}

async function startMediaRecorder(mime: string, deviceId: string | null): Promise<VoiceHandle> {
  const stream = await openMicrophone(deviceId)
  let monitor: LevelMonitor | null = null
  let ctx: AudioContext | null = null
  const release = () => {
    monitor?.stop()
    void ctx?.close().catch(() => {})
    stream.getTracks().forEach((t) => t.stop())
  }
  try {
    // A level meter + silence detection where the browser has Web Audio (else recording still works).
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (Ctx) {
        ctx = new Ctx()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        ctx.createMediaStreamSource(stream).connect(analyser)
        monitor = createLevelMonitor(analyser)
      }
    } catch {
      monitor = null
    }
    const recorder = new MediaRecorder(stream, { mimeType: mime })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data)
    }
    const startedAt = Date.now()
    let cancelled = false
    recorder.start(1000)
    return {
      deviceId: activeMicrophoneId(stream),
      getLevel: monitor ? () => monitor!.getLevel() : undefined,
      getSignal: monitor ? () => ({ maxPeak: monitor!.getMaxPeak(), showHint: monitor!.showHint() }) : undefined,
      stop: () =>
        new Promise<VoiceResult>((resolve, reject) => {
          recorder.onstop = () => {
            release()
            if (cancelled || chunks.length === 0) {
              reject(new VoiceError('failed', 'empty recording'))
              return
            }
            const type = baseMime(recorder.mimeType || mime)
            resolve({
              blob: new Blob(chunks, { type }),
              mimeType: type,
              durationSeconds: (Date.now() - startedAt) / 1000,
            })
          }
          try {
            recorder.stop()
          } catch (err) {
            release()
            reject(err)
          }
        }),
      cancel: () => {
        cancelled = true
        try {
          if (recorder.state !== 'inactive') recorder.stop()
        } catch {
          /* already stopped */
        }
        release()
      },
    }
  } catch (err) {
    release()
    throw err
  }
}

/**
 * Start a voice note on `deviceId` (the remembered microphone; null = the
 * browser default, and a device that has gone falls back to it). Rejects with VoiceError: 'unsupported' (offer no
 * mic), 'denied' (permission refused), or 'failed'.
 */
export function startVoiceRecording(allowedMimes: string[], deviceId: string | null = null): Promise<VoiceHandle> {
  const plans = planStrategies(detectRecorderEnv(), allowedMimes)
  return startWithFallback(plans, async (plan: Strategy) => {
    if (plan.kind === 'opus') {
      const chunk = await loadRecorderChunk()
      return chunk.startOpus(deviceId)
    }
    return startMediaRecorder(plan.mime, deviceId)
  })
}
