// A worked example and a smoke test: the real client library talking to the local simulator, with a script playing support.
//
//   cd gateway && npm run sim                       (in one terminal)
//   node scripts/sim-agent-selftest.mjs             (in another; needs `npm install` so the `ws` package is there)
//
// It prints one line per check and exits 1 if any fails. An app's own end-to-end tests can copy its shape.

import { createRequire } from 'node:module'
import { SimAgent } from './sim-agent.mjs'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const { VircleChatClient } = await import(new URL('../client/dist/index.js', import.meta.url).href)

const BASE = process.env.SIM_BASE || 'http://localhost:8090'
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}
const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  check(what, false, 'timed out')
  return false
}

const agent = await new SimAgent(BASE).login()
const user = await agent.createUser({ name: 'Selftest' })
const chat = new VircleChatClient({
  baseUrl: BASE,
  deviceId: 'selftest-device',
  getSession: agent.sessionFor(user.wallet_id),
  WebSocket,
  backoff: { minMs: 100, maxMs: 500, factor: 2, jitter: 0 },
  listenToEnvironment: false,
})

try {
  await chat.start()
  check('the app connects', await until('online', () => chat.getSnapshot().state === 'online'))
  chat.setScreenOpen(true)

  const sent = await chat.sendText('Hello from the app')
  check('a text message is stored (one tick or more)', ['sent', 'delivered', 'read'].includes(sent.status), sent.status)

  await agent.say(user.wallet_id, 'Hello from support')
  check('the app receives support\'s message', await until('support message', () => chat.getSnapshot().messages.some((m) => !m.mine && m.text === 'Hello from support')))

  await agent.read(user.wallet_id)
  check('the app\'s message turns read once the agent reads', await until('read tick', () => chat.getSnapshot().messages.find((m) => m.id === sent.id)?.status === 'read'))

  await agent.typing(user.wallet_id)
  check('the app shows support typing', await until('typing', () => chat.getSnapshot().supportTyping))

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
  await agent.sendFile(user.wallet_id, png, { contentType: 'image/png', fileName: 'dot.png', caption: 'a picture' })
  check('the app receives a photo with its caption', await until('photo', () => chat.getSnapshot().messages.some((m) => m.kind === 'image' && m.text === 'a picture')))
} finally {
  chat.stop()
  await agent.reset().catch(() => {})
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
