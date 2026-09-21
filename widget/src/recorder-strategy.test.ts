import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_LIMITS } from './types'
import {
  isPermissionError,
  planStrategies,
  startWithFallback,
  VoiceError,
  type RecorderEnv,
  type VoiceHandle,
} from './recorder-strategy'

const allowed = DEFAULT_LIMITS.allowedMimeTypes

function env(over: Partial<RecorderEnv> = {}): RecorderEnv {
  return {
    hasGetUserMedia: true,
    hasAudioContext: true,
    hasWorker: true,
    hasMediaRecorder: true,
    isTypeSupported: () => false,
    ...over,
  }
}

const handle: VoiceHandle = {
  stop: async () => ({ blob: new Blob(['x']), mimeType: 'audio/ogg', durationSeconds: 1 }),
  cancel: () => {},
}

describe('planStrategies', () => {
  it('prefers the in-browser Ogg/Opus encoder', () => {
    expect(planStrategies(env(), allowed)).toEqual([{ kind: 'opus' }])
  })

  it('adds a native MediaRecorder fallback only for an allowed, supported type', () => {
    const plans = planStrategies(
      env({ isTypeSupported: (m) => m === 'audio/ogg;codecs=opus' }),
      allowed,
    )
    expect(plans).toEqual([{ kind: 'opus' }, { kind: 'mediarecorder', mime: 'audio/ogg;codecs=opus' }])
  })

  it('never falls back to audio/webm (Chrome), which the bucket rejects', () => {
    const plans = planStrategies(env({ isTypeSupported: (m) => m.startsWith('audio/webm') }), allowed)
    expect(plans).toEqual([{ kind: 'opus' }])
  })

  it('uses audio/mp4 on Safari when the Opus path is unavailable', () => {
    const plans = planStrategies(
      env({ hasWorker: false, isTypeSupported: (m) => m === 'audio/mp4' }),
      allowed,
    )
    expect(plans).toEqual([{ kind: 'mediarecorder', mime: 'audio/mp4' }])
  })

  it('offers nothing without a microphone API, or when nothing allowed can be produced', () => {
    expect(planStrategies(env({ hasGetUserMedia: false }), allowed)).toEqual([])
    expect(planStrategies(env({ hasAudioContext: false, hasMediaRecorder: false }), allowed)).toEqual([])
  })

  it('respects the allow-list the server sent', () => {
    expect(planStrategies(env(), ['image/png'])).toEqual([])
    expect(planStrategies(env(), ['audio/ogg'])).toEqual([{ kind: 'opus' }])
  })
})

describe('startWithFallback', () => {
  it('returns the first strategy that starts', async () => {
    const start = vi.fn().mockResolvedValue(handle)
    await expect(startWithFallback([{ kind: 'opus' }, { kind: 'mediarecorder', mime: 'audio/mp4' }], start)).resolves.toBe(handle)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('moves on when the Opus chunk fails to load or start', async () => {
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk failed to load'))
      .mockResolvedValueOnce(handle)
    const result = await startWithFallback(
      [{ kind: 'opus' }, { kind: 'mediarecorder', mime: 'audio/ogg;codecs=opus' }],
      start,
    )
    expect(result).toBe(handle)
    expect(start).toHaveBeenCalledTimes(2)
    expect(start).toHaveBeenLastCalledWith({ kind: 'mediarecorder', mime: 'audio/ogg;codecs=opus' })
  })

  it('stops immediately on a microphone permission refusal', async () => {
    const denied = Object.assign(new Error('no'), { name: 'NotAllowedError' })
    const start = vi.fn().mockRejectedValue(denied)
    await expect(
      startWithFallback([{ kind: 'opus' }, { kind: 'mediarecorder', mime: 'audio/mp4' }], start),
    ).rejects.toMatchObject({ code: 'denied' })
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('reports unsupported when there is nothing to try, failed when everything failed', async () => {
    await expect(startWithFallback([], vi.fn())).rejects.toMatchObject({ code: 'unsupported' })
    const start = vi.fn().mockRejectedValue(new Error('boom'))
    const err = await startWithFallback([{ kind: 'opus' }], start).catch((e) => e)
    expect(err).toBeInstanceOf(VoiceError)
    expect(err.code).toBe('failed')
  })

  it('recognises permission errors by name', () => {
    expect(isPermissionError({ name: 'NotAllowedError' })).toBe(true)
    expect(isPermissionError({ name: 'SecurityError' })).toBe(true)
    expect(isPermissionError({ name: 'NotFoundError' })).toBe(false)
    expect(isPermissionError(null)).toBe(false)
  })
})
