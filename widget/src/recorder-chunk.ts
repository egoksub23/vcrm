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

import type { VoiceHandle, VoiceResult } from './recorder-strategy'

declare const __OPUS_WORKER_SOURCE__: string

async function startOpus(): Promise<VoiceHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new Ctx()
  let workerUrl: string | null = null

  const release = () => {
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
    const buffer = new Uint8Array(analyser.fftSize)

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
      getLevel: () => {
        analyser.getByteTimeDomainData(buffer)
        let peak = 0
        for (let i = 0; i < buffer.length; i++) {
          const dev = Math.abs(buffer[i] - 128) / 128
          if (dev > peak) peak = dev
        }
        return Math.min(1, peak * 2)
      },
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
