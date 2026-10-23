import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config'
import { chatAlertData, createPushAdapter, VirclePushAdapter, type PushRequest } from '../src/push'

const URL = 'https://apis-uat.vircle.com/airtable/send-mobile-alert'
const KEY = 'key-should-never-appear-anywhere'

const request = (over: Partial<PushRequest> = {}): PushRequest => ({
  phone: '+60123456789',
  email: 'a@example.com',
  walletId: 'W1',
  title: 'Vircle Care',
  body: 'You have a new message',
  deepLink: 'https://app.vircle.com/chat/c_1',
  collapseKey: 'c_1',
  data: chatAlertData('c_1', 'https://app.vircle.com/chat/c_1'),
  ...over,
})

interface Call {
  url: string
  init: RequestInit
  body: Record<string, unknown>
}
function adapter(answer: () => Response | Promise<Response>, over: { sendData?: boolean } = {}) {
  const calls: Call[] = []
  const a = new VirclePushAdapter({
    url: URL,
    apiKey: KEY,
    stage: 'uat',
    ...over,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: JSON.parse(String(init.body)) })
      return answer()
    }) as unknown as typeof fetch,
  })
  return { a, calls }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('the Vircle push adapter', () => {
  it('sends the phone number, the subject, the body and the alert data, signed with the key and the stage, and nothing else', async () => {
    const { a, calls } = adapter(() => json({ ok: true }))
    expect(await a.send(request())).toEqual({ status: 'sent' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(URL)
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': KEY, 'x-api-stage': 'uat' })
    expect(calls[0]!.body).toEqual({
      mobile_number: '+60123456789',
      subject: 'Vircle Care',
      body: 'You have a new message',
      data: { notification_type: '01', chat_alert: '1', conversation_id: 'c_1', deep_link: 'https://app.vircle.com/chat/c_1' },
    })
  })

  it('leaves the data out only when switched off, for an API that does not know the field', async () => {
    const { a, calls } = adapter(() => json({ ok: true }), { sendData: false })
    await a.send(request())
    expect(calls[0]!.body).toEqual({ mobile_number: '+60123456789', subject: 'Vircle Care', body: 'You have a new message' })
  })

  it('has nobody to alert without a phone number, and asks the API nothing', async () => {
    const { a, calls } = adapter(() => json({}))
    expect(await a.send(request({ phone: null }))).toEqual({ status: 'no_device' })
    expect(calls).toHaveLength(0)
  })

  it('reads "no client with that number" (404 ERA03) as no device, not as a fault', async () => {
    const { a } = adapter(() => json({ error: 'No client found', code: 'ERA03' }, 404))
    expect(await a.send(request())).toEqual({ status: 'no_device' })
  })

  it('does not mistake a wrong address (any other 404) for an unknown person', async () => {
    const { a } = adapter(() => new Response('Not Found', { status: 404 }))
    expect(await a.send(request())).toMatchObject({ status: 'failed', retryable: false })
  })

  it.each([
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [400, false],
    [401, false],
    [403, false],
  ])('a %i answer is a failure, retryable: %s', async (status, retryable) => {
    const { a } = adapter(() => json({ error: 'x', code: 'ERR01' }, status))
    const r = await a.send(request())
    expect(r).toMatchObject({ status: 'failed', retryable })
    expect(r.status === 'failed' && r.error).toContain(String(status))
  })

  it('retries later when the API cannot be reached, and never puts the key in an error', async () => {
    const { a } = adapter(() => {
      throw new TypeError(`fetch failed ${KEY}`)
    })
    const r = await a.send(request())
    expect(r).toMatchObject({ status: 'failed', retryable: true })
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('times out instead of waiting for ever', async () => {
    const a = new VirclePushAdapter({ url: URL, apiKey: KEY, stage: 'prod', timeoutMs: 50, fetch: ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('timeout', 'TimeoutError'))))) as unknown as typeof fetch })
    expect(await a.send(request())).toMatchObject({ status: 'failed', retryable: true })
  })

  it('refuses an address that is not https and a missing key', () => {
    expect(() => new VirclePushAdapter({ url: 'http://x.example/alert', apiKey: KEY, stage: 'uat' })).toThrow(/https/)
    expect(() => new VirclePushAdapter({ url: URL, apiKey: '', stage: 'uat' })).toThrow(/key/)
  })
})

describe('configuring the real adapter', () => {
  const base = { DATABASE_URL: 'x', GATEWAY_ENCRYPTION_KEY: '00'.repeat(32) }

  it('needs address, key and an explicit stage, so a half-set gateway does not start', () => {
    expect(() => loadConfig({ ...base, PUSH_ADAPTER: 'vircle' })).toThrow(/PUSH_API_URL, PUSH_API_KEY and PUSH_API_STAGE/)
    expect(() => loadConfig({ ...base, PUSH_ADAPTER: 'vircle', PUSH_API_URL: URL, PUSH_API_KEY: KEY })).toThrow(/PUSH_API_STAGE/)
    expect(() => loadConfig({ ...base, PUSH_ADAPTER: 'vircle', PUSH_API_URL: URL, PUSH_API_KEY: KEY, PUSH_API_STAGE: 'staging' })).toThrow(/uat or prod/)
    expect(() => loadConfig({ ...base, PUSH_ADAPTER: 'vircle', PUSH_API_URL: 'http://x.example', PUSH_API_KEY: KEY, PUSH_API_STAGE: 'uat' })).toThrow(/https/)
  })

  it('builds the adapter from the settings, with the data on unless switched off', () => {
    const cfg = loadConfig({ ...base, PUSH_ADAPTER: 'vircle', PUSH_API_URL: URL, PUSH_API_KEY: KEY, PUSH_API_STAGE: 'uat' })
    expect(cfg.push.api).toEqual({ url: URL, key: KEY, stage: 'uat', sendData: true, timeoutMs: 10_000 })
    expect(createPushAdapter(cfg).name).toBe('vircle')
    expect(loadConfig({ ...base, PUSH_ADAPTER: 'vircle', PUSH_API_URL: URL, PUSH_API_KEY: KEY, PUSH_API_STAGE: 'prod', PUSH_API_SEND_DATA: 'false' }).push.api.sendData).toBe(false)
  })

  it('stays on the mock by default and needs none of it', () => {
    const cfg = loadConfig(base)
    expect(createPushAdapter(cfg).name).toBe('mock')
    expect(cfg.push.api).toMatchObject({ url: null, key: null, stage: null })
  })
})
