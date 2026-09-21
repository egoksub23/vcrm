import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  chooseDevice,
  isSilentTake,
  listMicrophones,
  meterLevel,
  openMicrophone,
  peakFromTimeDomain,
  SILENCE_HINT_MS,
  SILENCE_THRESHOLD,
  SilenceTracker,
  toMicOptions,
} from './mic'
import { readSavedMic, writeSavedMic } from './storage'

afterEach(() => {
  vi.unstubAllGlobals()
})

const name = (n: number) => `Microphone ${n}`

describe('peakFromTimeDomain / meterLevel', () => {
  it('reads a flat 128 buffer (digital silence) as 0', () => {
    expect(peakFromTimeDomain(new Uint8Array(512).fill(128))).toBe(0)
  })

  it('reads the largest deviation from the centre line, either side', () => {
    const buf = new Uint8Array(512).fill(128)
    buf[10] = 128 + 64
    buf[20] = 128 - 96
    expect(peakFromTimeDomain(buf)).toBeCloseTo(96 / 128)
  })

  it('boosts and clamps the meter level to 0..1', () => {
    expect(meterLevel(0)).toBe(0)
    expect(meterLevel(0.25)).toBe(0.5)
    expect(meterLevel(0.9)).toBe(1)
    expect(meterLevel(-1)).toBe(0)
  })
})

describe('isSilentTake', () => {
  it('flags a take whose loudest sample never reached the threshold', () => {
    expect(isSilentTake(0)).toBe(true)
    expect(isSilentTake(SILENCE_THRESHOLD - 0.001)).toBe(true)
  })
  it('accepts a take with any real signal', () => {
    expect(isSilentTake(SILENCE_THRESHOLD)).toBe(false)
    expect(isSilentTake(0.3)).toBe(false)
  })
})

describe('SilenceTracker', () => {
  it('shows the hint only after ~2 s with nothing heard', () => {
    const t = new SilenceTracker(1000)
    t.push(0.001)
    expect(t.showHint(1000 + SILENCE_HINT_MS - 1)).toBe(false)
    expect(t.showHint(1000 + SILENCE_HINT_MS)).toBe(true)
    expect(t.heardAnything).toBe(false)
    expect(isSilentTake(t.maxPeak)).toBe(true)
  })

  it('never shows the hint once anything was heard, even after a long pause', () => {
    const t = new SilenceTracker(0)
    t.push(0.4)
    expect(t.heardAnything).toBe(true)
    t.push(0)
    expect(t.showHint(60_000)).toBe(false)
    expect(isSilentTake(t.maxPeak)).toBe(false)
  })

  it('hides the hint again as soon as signal appears (e.g. after picking another mic)', () => {
    const t = new SilenceTracker(0)
    expect(t.showHint(5000)).toBe(true)
    t.push(0.05)
    expect(t.showHint(5000)).toBe(false)
  })

  it('treats near-zero noise below the threshold as silence', () => {
    const t = new SilenceTracker(0)
    for (let i = 0; i < 100; i++) t.push(0.01)
    expect(t.showHint(3000)).toBe(true)
    expect(t.maxPeak).toBeCloseTo(0.01)
  })
})

describe('toMicOptions / chooseDevice', () => {
  const dev = (deviceId: string, label: string, kind = 'audioinput') => ({ kind, deviceId, label })

  it('lists only real audio inputs, dropping the Windows default/communications aliases', () => {
    const opts = toMicOptions(
      [
        dev('default', 'Default - Monitor Audio'),
        dev('communications', 'Communications - Monitor Audio'),
        dev('abc', 'Monitor Audio (HDMI)'),
        dev('def', 'Headset Microphone'),
        dev('spk', 'Speakers', 'audiooutput'),
        dev('cam', 'Webcam', 'videoinput'),
      ],
      name,
    )
    expect(opts).toEqual([
      { id: 'abc', label: 'Monitor Audio (HDMI)' },
      { id: 'def', label: 'Headset Microphone' },
    ])
  })

  it('numbers unlabelled devices (labels are hidden until access is granted)', () => {
    expect(toMicOptions([dev('a', ''), dev('b', '  ')], name)).toEqual([
      { id: 'a', label: 'Microphone 1' },
      { id: 'b', label: 'Microphone 2' },
    ])
  })

  it('keeps the default entry when it is all there is', () => {
    expect(toMicOptions([dev('default', 'Default')], name)).toEqual([{ id: 'default', label: 'Default' }])
  })

  it('remembers the saved device only while it is still plugged in', () => {
    const list = [{ id: 'abc' }, { id: 'def' }]
    expect(chooseDevice('def', list)).toBe('def')
    expect(chooseDevice('gone', list)).toBeNull()
    expect(chooseDevice(null, list)).toBeNull()
  })
})

describe('openMicrophone', () => {
  function stubMedia(getUserMedia: (c: unknown) => Promise<unknown>, devices: unknown[] = []) {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: async () => devices } })
  }

  it('asks for the exact remembered device', async () => {
    const stream = { id: 's' }
    const gum = vi.fn(async () => stream)
    stubMedia(gum)
    await expect(openMicrophone('abc')).resolves.toBe(stream)
    expect(gum).toHaveBeenCalledTimes(1)
    expect(gum).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'abc' } } })
  })

  it('uses the browser default when nothing was chosen', async () => {
    const gum = vi.fn(async () => ({}))
    stubMedia(gum)
    await openMicrophone(null)
    expect(gum).toHaveBeenCalledWith({ audio: true })
  })

  it('falls back to the default when the remembered device disappeared', async () => {
    for (const errName of ['OverconstrainedError', 'NotFoundError']) {
      const fallback = { id: 'default-stream' }
      const gum = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('gone'), { name: errName }))
        .mockResolvedValueOnce(fallback)
      stubMedia(gum)
      await expect(openMicrophone('unplugged')).resolves.toBe(fallback)
      expect(gum).toHaveBeenNthCalledWith(2, { audio: true })
    }
  })

  it('does NOT retry on a permission refusal (it would only prompt again)', async () => {
    const gum = vi.fn().mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' }))
    stubMedia(gum)
    await expect(openMicrophone('abc')).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(gum).toHaveBeenCalledTimes(1)
  })

  it('lists microphones through enumerateDevices, and tolerates it failing', async () => {
    stubMedia(async () => ({}), [
      { kind: 'audioinput', deviceId: 'x', label: 'USB Mic' },
      { kind: 'audiooutput', deviceId: 'y', label: 'Speaker' },
    ])
    await expect(listMicrophones(name)).resolves.toEqual([{ id: 'x', label: 'USB Mic' }])
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: async () => {
          throw new Error('blocked')
        },
      },
    })
    await expect(listMicrophones(name)).resolves.toEqual([])
  })
})

describe('remembered microphone (localStorage)', () => {
  it('round-trips the chosen device id', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    })
    expect(readSavedMic()).toBeNull()
    writeSavedMic('device-42')
    expect(readSavedMic()).toBe('device-42')
  })

  it('works (as "not remembered") when storage throws, e.g. private mode', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
      },
    })
    expect(readSavedMic()).toBeNull()
    expect(() => writeSavedMic('x')).not.toThrow()
  })
})
