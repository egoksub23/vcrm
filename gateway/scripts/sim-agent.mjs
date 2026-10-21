// ============================================================
// A script's way to be "Halo's agent" against the local simulator (`npm run sim`), so an automated test can play the support side of
// a chat with no person and no Halo: create a test user, mint a connect token, send messages and files as support, mark them read.
//
//   import { SimAgent } from './sim-agent.mjs'
//   const agent = await new SimAgent('http://localhost:8090').login()
//   const user = await agent.createUser({ name: 'Aisha' })           // { wallet_id, name, phone, email, conversation_id }
//   const getSession = agent.sessionFor(user.wallet_id)               // what the app's backend would answer: { token, wsPath }
//   await agent.say(user.wallet_id, 'Hello from support')
//
// Needs Node 20 or later (global fetch). Only the local simulator or a gateway started with SIMULATOR_ENABLED=true; it can only act on
// the test users it creates (wallet ids `sim_...`). No dependencies. Selftest: `node scripts/sim-agent-selftest.mjs`.
// ============================================================

export class SimAgent {
  /** @param {string} base the gateway, for example http://localhost:8090 */
  constructor(base = 'http://localhost:8090') {
    this.base = base.replace(/\/+$/, '')
    this.session = null
  }

  /** Opens a simulator session through the local launch link (`GET /launch` is only served by `npm run sim`). */
  async login() {
    const launch = await fetch(`${this.base}/launch`, { redirect: 'manual' })
    const location = launch.headers.get('location') ?? ''
    const token = /[#&?]t=([^&]+)/.exec(location)?.[1]
    if (!token) throw new Error(`The launch link gave no token (is this the local simulator? status ${launch.status})`)
    return this.loginWith(decodeURIComponent(token))
  }

  /** For a gateway Halo launched: the token from the launch link Halo's "Open simulator" button made. */
  async loginWith(launchToken) {
    const r = await this.#call('POST', '/simulator/api/login', { token: launchToken }, false)
    this.session = r.session
    return this
  }

  createUser({ name, phone, email } = {}) {
    return this.#call('POST', '/simulator/api/users', { name, phone, email })
  }

  users() {
    return this.#call('GET', '/simulator/api/users').then((r) => r.users)
  }

  /** What the Vircle backend would hand the app: a one-time connect token. */
  connectToken(walletId) {
    return this.#call('POST', '/simulator/api/connect-token', { wallet_id: walletId })
  }

  /** A `getSession` for the client library: asks for a fresh token every time it is called. */
  sessionFor(walletId) {
    return async () => {
      const t = await this.connectToken(walletId)
      return { token: t.token, wsPath: t.ws_path }
    }
  }

  /** A text message from support. `replyToServerId` quotes one of the user's or support's messages. */
  say(walletId, text, { replyToServerId } = {}) {
    return this.#call('POST', '/simulator/api/agent-message', { wallet_id: walletId, text, reply_to_server_id: replyToServerId })
  }

  /** A file from support. `bytes` is a Buffer or Uint8Array; `contentType` decides the kind (image, video, audio, document). */
  async sendFile(walletId, bytes, { contentType, fileName, caption, durationSeconds, animated, replyToServerId }) {
    const headers = { 'x-sim-session': this.session, 'content-type': contentType, 'x-wallet-id': walletId }
    if (fileName) headers['x-file-name'] = encodeURIComponent(fileName)
    if (caption) headers['x-caption'] = encodeURIComponent(caption)
    if (durationSeconds) headers['x-duration'] = String(durationSeconds)
    if (animated) headers['x-animated'] = '1'
    if (replyToServerId) headers['x-reply-to'] = replyToServerId
    const res = await fetch(`${this.base}/simulator/api/agent-file`, { method: 'POST', headers, body: bytes })
    return this.#parse(res, 'POST /simulator/api/agent-file')
  }

  /** Mark everything the user wrote as read, as Halo does when an agent opens the chat. */
  read(walletId) {
    return this.#call('POST', '/simulator/api/agent-read', { wallet_id: walletId })
  }

  /** Show "Support is typing..." in the user's app. */
  typing(walletId) {
    return this.#call('POST', '/simulator/api/agent-typing', { wallet_id: walletId })
  }

  /** The conversation as the agent sees it (the last 100 messages) with the status the app's receipts gave each. */
  messages(walletId) {
    return this.#call('GET', `/simulator/api/messages?wallet_id=${encodeURIComponent(walletId)}`)
  }

  /** The alerts the gateway raised for the user while the app was closed (mock push). */
  push(walletId) {
    return this.#call('GET', `/simulator/api/push?wallet_id=${encodeURIComponent(walletId)}`)
  }

  /** Forget every test user. */
  reset() {
    return this.#call('POST', '/simulator/api/reset', {})
  }

  async #call(method, path, body, authed = true) {
    const headers = { 'content-type': 'application/json' }
    if (authed) headers['x-sim-session'] = this.session
    const res = await fetch(`${this.base}${path}`, { method, headers, ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }) })
    return this.#parse(res, `${method} ${path}`)
  }

  async #parse(res, what) {
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {}
    if (!res.ok) throw new Error(`${what} -> ${res.status} ${json?.message ?? json?.error ?? text.slice(0, 200)}`)
    return json
  }
}
