// ============================================================
// Microphone selection and silence detection for voice notes.
//
// The browser's DEFAULT input is often the wrong one on a multi-monitor
// Windows desk (a monitor's HDMI audio, a virtual cable), and records
// pure silence. So the visitor can pick the input, the choice is
// remembered, and a take with no signal is flagged while it is recording
// and again before it is sent. Same idea and threshold as the CRM
// composer (src/lib/media/microphone.ts).
//
// The maths (SilenceTracker, peakFromTimeDomain, chooseDevice, ...) is
// pure and unit-tested in mic.test.ts; only openMicrophone /
// listMicrophones / createLevelMonitor touch the browser.
// ============================================================

/** A silent take reads well under this (peak deviation from centre, 0..1). */
export const SILENCE_THRESHOLD = 0.015
/** How long with no signal at all before the "we can't hear you" hint appears. */
export const SILENCE_HINT_MS = 2000

/** Loudest sample in an analyser window, 0 (silence) .. 1 (clipping). */
export function peakFromTimeDomain(buffer: ArrayLike<number>): number {
  let peak = 0
  for (let i = 0; i < buffer.length; i++) {
    const deviation = Math.abs(buffer[i] - 128) / 128
    if (deviation > peak) peak = deviation
  }
  return peak
}

/** Raw peak -> 0..1 for the on-screen meter (speech peaks sit low, so boost). */
export function meterLevel(rawPeak: number): number {
  return Math.max(0, Math.min(1, rawPeak * 2))
}

/** True when the loudest thing ever heard is below the silence threshold. */
export function isSilentTake(maxPeak: number): boolean {
  return maxPeak < SILENCE_THRESHOLD
}

/**
 * Tracks whether the microphone has produced ANY signal since recording
 * began. The hint is only shown while nothing at all has been heard, so a
 * pause mid-sentence never triggers it.
 */
export class SilenceTracker {
  private readonly startedAt: number
  private heard = false
  private max = 0

  constructor(
    startedAt: number,
    private readonly threshold = SILENCE_THRESHOLD,
    private readonly holdMs = SILENCE_HINT_MS,
  ) {
    this.startedAt = startedAt
  }

  push(rawPeak: number): void {
    if (rawPeak > this.max) this.max = rawPeak
    if (rawPeak >= this.threshold) this.heard = true
  }

  get maxPeak(): number {
    return this.max
  }

  get heardAnything(): boolean {
    return this.heard
  }

  /** True once `holdMs` has passed since the start without ever hearing a signal. */
  showHint(now: number): boolean {
    return !this.heard && now - this.startedAt >= this.holdMs
  }
}

export interface MicOption {
  id: string
  label: string
}

interface DeviceLike {
  kind: string
  deviceId: string
  label: string
}

/**
 * Audio inputs for the picker. Windows lists every device twice more as
 * "default" and "communications"; those virtual entries are dropped (the
 * browser default is what we use when nothing is chosen). Labels are only
 * filled in once microphone access is granted, hence the numbered fallback.
 */
export function toMicOptions(devices: readonly DeviceLike[], fallbackName: (n: number) => string): MicOption[] {
  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId)
  const real = inputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
  const list = real.length ? real : inputs
  return list.map((d, i) => ({ id: d.deviceId, label: (d.label || '').trim() || fallbackName(i + 1) }))
}

/** The remembered device if it is still plugged in, else null (= browser default). */
export function chooseDevice(saved: string | null, available: readonly { id: string }[]): string | null {
  if (!saved) return null
  return available.some((d) => d.id === saved) ? saved : null
}

function errorName(err: unknown): string {
  return (err as { name?: string } | null)?.name ?? ''
}

/**
 * Opens the chosen microphone. A remembered device that has since been
 * unplugged (OverconstrainedError / NotFoundError) falls back to the
 * browser default instead of failing; a permission refusal is rethrown.
 */
export async function openMicrophone(deviceId?: string | null): Promise<MediaStream> {
  const md = navigator.mediaDevices
  if (deviceId) {
    try {
      return await md.getUserMedia({ audio: { deviceId: { exact: deviceId } } })
    } catch (err) {
      const name = errorName(err)
      if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw err
    }
  }
  return md.getUserMedia({ audio: true })
}

/** The device the stream is actually using. */
export function activeMicrophoneId(stream: MediaStream): string | null {
  try {
    return stream.getAudioTracks()[0]?.getSettings().deviceId ?? null
  } catch {
    return null
  }
}

/** Audio inputs the browser knows about (labelled once access was granted). */
export async function listMicrophones(fallbackName: (n: number) => string): Promise<MicOption[]> {
  try {
    return toMicOptions(await navigator.mediaDevices.enumerateDevices(), fallbackName)
  } catch {
    return []
  }
}

export interface LevelMonitor {
  /** 0..1, for the meter (loudest recent sample, decays). */
  getLevel(): number
  /** Loudest raw peak since the start, 0..1. */
  getMaxPeak(): number
  /** True once ~2 s have passed with nothing heard. */
  showHint(): boolean
  stop(): void
}

/**
 * Samples an analyser every 50 ms so a short word is not missed between the
 * UI's slower redraws. Both recorder strategies share it.
 */
export function createLevelMonitor(analyser: AnalyserNode, now: () => number = Date.now): LevelMonitor {
  const buffer = new Uint8Array(analyser.fftSize)
  const tracker = new SilenceTracker(now())
  let recent = 0
  const sample = () => {
    analyser.getByteTimeDomainData(buffer)
    const peak = peakFromTimeDomain(buffer)
    tracker.push(peak)
    recent = Math.max(peak, recent * 0.7)
  }
  const id = setInterval(sample, 50)
  return {
    getLevel: () => meterLevel(recent),
    getMaxPeak: () => tracker.maxPeak,
    showHint: () => tracker.showHint(now()),
    stop: () => clearInterval(id),
  }
}
