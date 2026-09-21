// ============================================================
// Lazy entry: built by scripts/build-widget.mjs into
// public/widget/recorder.js and loaded from the API origin the first
// time a visitor taps the microphone. Contains opus-recorder plus the
// encoder worker (inlined as text and started from a blob: URL, since
// a Worker cannot be created from another origin's URL — the widget
// runs on the HOST page's origin).
//
// Output is a complete Ogg/Opus file (audio/ogg), which the chat-media
// bucket accepts and WhatsApp plays as a voice note — the same encoder
// settings the CRM composer uses (src/components/inbox/message-composer.tsx).
// ============================================================
import Recorder from 'opus-recorder'

import { activeMicrophoneId, createLevelMonitor, openMicrophone } from './mic'
import type { VoiceHandle, VoiceResult } from './recorder-strategy'

declare const __OPUS_WORKER_SOURCE__: string

async function startOpus(deviceId: string | null = null): Promise<VoiceHandle> {
  const stream = await openMicrophone(deviceId)
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new Ctx()
  let workerUrl: string | null = null
  let monitor: ReturnType<typeof createLevelMonitor> | null = null

  const release = () => {
    monitor?.stop()
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close().catch(() => {})
    if (workerUrl) URL.revokeObjectURL(workerUrl)
    workerUrl = null
  }

  try {
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    monitor = createLevelMonitor(analyser)

    workerUrl = URL.createObjectURL(
      new Blob([__OPUS_WORKER_SOURCE__], { type: 'application/javascript' }),
    )
    const recorder = new Recorder({
      encoderPath: workerUrl,
      numberOfChannels: 1,
      encoderApplication: 2048, // VOIP — tuned for speech
      encoderSampleRate: 48000,
      streamPages: false, // one callback with the complete file on stop
      sourceNode: source,
    })

    let cancelled = false
    let onBytes: ((b: Uint8Array) => void) | null = null
    const bytesPromise = new Promise<Uint8Array>((resolve) => {
      onBytes = resolve
    })
    recorder.ondataavailable = (bytes) => onBytes?.(bytes)

    const startedAt = Date.now()
    await recorder.start()

    return {
      deviceId: activeMicrophoneId(stream),
      getLevel: () => monitor?.getLevel() ?? 0,
      getSignal: () => ({ maxPeak: monitor?.getMaxPeak() ?? 0, showHint: monitor?.showHint() ?? false }),
      stop: async (): Promise<VoiceResult> => {
        try {
          await recorder.stop()
          const bytes = await Promise.race([
            bytesPromise,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('encoder timeout')), 10_000)),
          ])
          if (cancelled || bytes.length === 0) throw new Error('empty recording')
          return {
            blob: new Blob([bytes as unknown as BlobPart], { type: 'audio/ogg' }),
            mimeType: 'audio/ogg',
            durationSeconds: (Date.now() - startedAt) / 1000,
          }
        } finally {
          release()
        }
      },
      cancel: () => {
        cancelled = true
        void recorder
          .stop()
          .catch(() => {})
          .finally(release)
      },
    }
  } catch (err) {
    release()
    throw err
  }
}

const registry = (window.__vircleWidgetLazy = window.__vircleWidgetLazy ?? {})
registry.recorder = { startOpus }
