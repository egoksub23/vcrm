// ============================================================
// A stand-in for the Vircle chat gateway, so Halo's Vircle Chat channel can be
// built and tested before the real gateway exists, and so the gateway team can
// see exactly what Halo sends and expects (docs/vircle-chat-contract.md).
//
// Node 18+ only; no dependencies.
//
//   node scripts/vircle-chat-mock.mjs serve [--port 4010] [--token T]
//       Runs the gateway side Halo calls: POST /v1/messages and GET /v1/health.
//       Checks the bearer token, answers 202 with a server_id, honours the
//       Idempotency-Key (the same key returns the same answer, never a new
//       message), and prints what it received. In Halo set the gateway address
//       to http://localhost:4010 and the API token to the one printed here.
//         --delivery socket|push|queued|no_device   what to answer (default socket)
//         --fail user_not_found|rate_limited|...     answer every send with that error
//
//   node scripts/vircle-chat-mock.mjs inbound --halo URL --key WORKSPACE_KEY --secret SECRET \
//        --wallet W123 [--name Aisha] [--phone +60...] [--email a@b.c] [--text "Hi"] \
//        [--image-url https://... --mime image/png]
//       Sends Halo a correctly signed message.inbound event.
//
//   node scripts/vircle-chat-mock.mjs receipt --halo URL --key K --secret S --server-id m_1 \
//        [--status delivered|read|failed]
//       Sends Halo a signed message.receipt event.
//
//   Add --replay to either command to send the identical request twice (Halo must
//   accept the first and treat the second as a no-op), or --stale to sign with a
//   timestamp ten minutes old (Halo must refuse it with 401).
// ============================================================
import { createHmac, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const [command, ...rest] = process.argv.slice(2)
const flags = {}
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) continue
  const key = rest[i].slice(2)
  const next = rest[i + 1]
  if (next === undefined || next.startsWith('--')) flags[key] = true
  else {
    flags[key] = next
    i++
  }
}

const sign = (secret, timestamp, body) => 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')

async function postSigned(path, payload) {
  const halo = String(flags.halo || '').replace(/\/+$/, '')
  if (!halo || !flags.secret) throw new Error('--halo and --secret are required')
  const body = JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1000) - (flags.stale ? 600 : 0)
  const send = async () => {
    const res = await fetch(`${halo}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vircle-timestamp': String(timestamp),
        'x-vircle-signature': sign(String(flags.secret), timestamp, body),
      },
      body,
    })
    console.log(`${res.status} ${await res.text()}`)
  }
  await send()
  if (flags.replay) {
    console.log('(replaying the identical request)')
    await send()
  }
}

if (command === 'serve') {
  const port = Number(flags.port || 4010)
  const token = String(flags.token || 'mock-token')
  const delivery = String(flags.delivery || 'socket')
  const failure = flags.fail ? String(flags.fail) : null
  const seen = new Map() // Idempotency-Key -> answer
  let seq = 0

  createServer((req, res) => {
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(obj))
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      return send(401, { error: { code: 'unauthorized', message: 'Bad or missing bearer token' } })
    }
    if (req.method === 'GET' && req.url === '/v1/health') return send(200, { ok: true })
    if (req.method === 'POST' && req.url === '/v1/messages') {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const key = req.headers['idempotency-key']
        if (!key) return send(400, { error: { code: 'bad_request', message: 'Idempotency-Key is required' } })
        let body
        try {
          body = JSON.parse(raw)
        } catch {
          return send(400, { error: { code: 'bad_request', message: 'Body is not JSON' } })
        }
        if (!body?.recipient?.wallet_id) return send(400, { error: { code: 'user_not_found', message: 'recipient.wallet_id is required' } })
        if (failure) {
          const status = failure === 'rate_limited' ? 429 : 400
          return send(status, { error: { code: failure, message: `Mock failure: ${failure}` } }, status === 429 ? { 'retry-after': '5' } : {})
        }
        const again = seen.get(key)
        const answer = again ?? { server_id: `m_${++seq}`, seq, conversation_id: body.conversation_id || `c_${body.recipient.wallet_id}`, delivery }
        seen.set(key, answer)
        console.log(`${again ? 'REPEAT' : 'NEW   '} ${key} -> ${JSON.stringify(body)}`)
        send(202, answer)
      })
      return
    }
    send(404, { error: { code: 'not_found', message: 'No such route' } })
  }).listen(port, () => {
    console.log(`Mock gateway on http://localhost:${port}\n  API token: ${token}\n  answers delivery="${delivery}"${failure ? `, failing with ${failure}` : ''}`)
  })
} else if (command === 'inbound') {
  const user = { wallet_id: String(flags.wallet || 'W123') }
  if (flags.name) user.name = String(flags.name)
  if (flags.phone) user.phone = String(flags.phone)
  if (flags.email) user.email = String(flags.email)
  const message = { server_id: `m_in_${randomUUID().slice(0, 8)}`, client_id: randomUUID(), seq: 1, sent_at: new Date().toISOString() }
  if (flags['image-url']) {
    message.type = 'image'
    message.media = { url: String(flags['image-url']), mime_type: String(flags.mime || 'image/png'), file_name: 'mock.png' }
    if (flags.text) message.text = String(flags.text)
  } else {
    message.type = 'text'
    message.text = String(flags.text || 'Hello from the mock gateway')
  }
  await postSigned('/api/vircle-chat/webhook', {
    event: 'message.inbound',
    event_id: `evt_${randomUUID()}`,
    workspace_key: String(flags.key || ''),
    user,
    conversation_id: `c_${user.wallet_id}`,
    message,
  })
} else if (command === 'receipt') {
  await postSigned('/api/vircle-chat/webhook', {
    event: 'message.receipt',
    event_id: `evt_${randomUUID()}`,
    workspace_key: String(flags.key || ''),
    server_id: String(flags['server-id'] || ''),
    status: String(flags.status || 'delivered'),
    at: new Date().toISOString(),
  })
} else {
  console.log('Usage: node scripts/vircle-chat-mock.mjs serve | inbound | receipt   (see the header of this file)')
  process.exit(command ? 1 : 0)
}
