// Vircle Chat simulator (served by the gateway; docs/vircle-chat-gateway-scope.md, section 4).
// The browser here plays the Vircle app: it talks to the gateway over the same WebSocket protocol the
// real app will (src/protocol.ts), and the panels show what the gateway does around it. All text from
// messages is written with textContent, never as HTML.
(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v
      else if (k === 'text') node.textContent = v
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
      else node.setAttribute(k, v)
    }
    for (const c of children) if (c) node.append(c)
    return node
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  let session = null
  let config = null
  let current = null // wallet id of the selected phone
  let tab = 'push'
  const phones = new Map()
  let usersCache = []

  // ------------------------------------------------------------ API

  async function api(path, method = 'GET', body) {
    const res = await fetch(`/simulator/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-sim-session': session || '' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (res.status === 401) endSession()
      throw new Error(data?.error?.message || `Request failed (${res.status})`)
    }
    return data
  }

  let toastTimer
  function toast(text) {
    const t = $('toast')
    t.textContent = text
    t.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (t.hidden = true), 4500)
  }

  function endSession() {
    session = null
    try { sessionStorage.removeItem('vsim') } catch {}
    $('app').hidden = true
    const n = $('login')
    n.hidden = false
    n.textContent = 'This simulator session has ended or was never started. Open it from Halo: Settings, Channels, Vircle Chat, Open simulator.'
  }

  // ------------------------------------------------------------ phones (the app side)

  function phoneFor(u) {
    let p = phones.get(u.wallet_id)
    if (!p) {
      p = { wallet: u.wallet_id, name: u.name, phone: u.phone, email: u.email, ws: null, connected: false, msgs: [], lastSeq: 0, wire: [], lastSend: null }
      phones.set(u.wallet_id, p)
    }
    return p
  }
  const cur = () => (current ? phones.get(current) : null)

  function wire(p, dir, text, cls = '') {
    p.wire.push({ at: new Date().toISOString(), dir, text, cls: cls || dir })
    if (p.wire.length > 300) p.wire.shift()
    if (p === cur() && tab === 'wire') renderWire()
  }

  function sendFrame(p, frame) {
    if (!p.ws || p.ws.readyState !== WebSocket.OPEN) return false
    const text = JSON.stringify(frame)
    p.ws.send(text)
    wire(p, 'out', text)
    return true
  }

  async function openApp(p) {
    if (p.ws) return
    const t = await api('/connect-token', 'POST', { wallet_id: p.wallet })
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}${t.ws_path}`)
    p.ws = ws
    wire(p, 'sys', 'Connecting…')
    ws.onopen = () => sendFrame(p, { type: 'hello', v: 1, token: t.token, device_id: 'sim-browser', app_version: 'simulator', last_seq: p.lastSeq })
    ws.onmessage = (ev) => {
      let f
      try { f = JSON.parse(ev.data) } catch { return }
      wire(p, 'in', ev.data, f.type === 'error' ? 'err' : 'in')
      onFrame(p, f)
    }
    ws.onclose = (ev) => {
      wire(p, 'sys', `Connection closed (${ev.code}${ev.reason ? ' ' + ev.reason : ''})`, ev.code === 1000 ? 'sys' : 'err')
      if (p.ws === ws) { p.ws = null; p.connected = false }
      render()
    }
    ws.onerror = () => wire(p, 'sys', 'Connection error', 'err')
    render()
  }

  function closeApp(p, code = 1000, reason = 'app closed') {
    if (p.ws) p.ws.close(code, reason)
  }

  function onFrame(p, f) {
    switch (f.type) {
      case 'welcome':
        p.connected = true
        addSys(p, 'App open')
        break
      case 'deliver':
        onDeliver(p, f)
        break
      case 'ack': {
        const m = p.msgs.find((x) => x.client_id === f.client_id)
        if (m) { m.state = 'sent'; m.server_id = f.server_id; m.seq = f.seq; if (f.duplicate) m.note = 'duplicate absorbed' }
        p.lastSeq = Math.max(p.lastSeq, f.seq)
        break
      }
      case 'resume_done':
        if (f.more) sendFrame(p, { type: 'resume', last_seq: p.lastSeq })
        break
      case 'error':
        toast(`${f.code}: ${f.message}`)
        break
    }
    render()
  }

  function addSys(p, text) {
    p.msgs.push({ sys: true, text, at: new Date().toISOString() })
  }

  function onDeliver(p, f) {
    if (p.msgs.some((m) => m.server_id === f.server_id)) return
    p.msgs.push({ direction: f.direction, text: f.text, kind: f.kind, server_id: f.server_id, seq: f.seq, sender: f.sender && f.sender.name, state: 'sent', at: f.sent_at })
    p.lastSeq = Math.max(p.lastSeq, f.seq)
    if (f.direction === 'out') scheduleAck(p, f.seq)
  }

  function scheduleAck(p, seq) {
    if (!$('auto-ack').checked) return
    const delay = Number($('ack-delay').value) || 0
    setTimeout(() => {
      if (!p.ws || !p.connected || !$('auto-ack').checked) return
      sendFrame(p, { type: 'receipt', up_to_seq: seq, status: 'delivered' })
      if ($('screen-open').checked) sendFrame(p, { type: 'receipt', up_to_seq: seq, status: 'read' })
    }, delay)
  }

  function sendText(p, text) {
    const client_id = `c-${crypto.randomUUID()}`
    const frame = { type: 'send', client_id, kind: 'text', text }
    p.msgs.push({ direction: 'in', text, client_id, state: 'pending', at: new Date().toISOString() })
    p.lastSend = frame
    if (!sendFrame(p, frame)) toast('The app is closed: open it first')
    render()
  }

  // ------------------------------------------------------------ rendering

  function render() {
    renderUsers()
    renderPhone()
    if (tab === 'wire') renderWire()
  }

  function renderUsers() {
    const list = $('user-list')
    list.replaceChildren(
      ...usersCache.map((u) => {
        const p = phones.get(u.wallet_id)
        const online = p ? p.connected : u.online
        return el(
          'li',
          { class: `user${u.wallet_id === current ? ' sel' : ''}`, onclick: () => select(u.wallet_id) },
          el('span', {}, el('span', { class: `dot${online ? ' on' : ''}` }), u.name || u.wallet_id),
          el('span', { class: 'muted small', text: u.wallet_id }),
        )
      }),
    )
    if (usersCache.length === 0) list.append(el('li', { class: 'muted', text: 'No test users yet. Add one above.' }))
  }

  function renderPhone() {
    const p = cur()
    $('phone-name').textContent = p ? p.name || p.wallet : 'No user selected'
    $('phone-sub').textContent = p ? `${p.wallet} · ${p.phone || ''}` : 'Add a test user, then open the app'
    const conn = $('conn')
    conn.className = `pill ${p && p.connected ? 'on' : 'off'}`
    conn.textContent = p && p.connected ? 'App open' : p && p.ws ? 'Connecting…' : 'App closed'
    const box = $('messages')
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
    box.replaceChildren(
      ...(p ? p.msgs : []).map((m) => {
        if (m.sys) return el('div', { class: 'sys', text: `${m.text} · ${clock(m.at)}` })
        const mine = m.direction === 'in'
        const meta = mine ? (m.state === 'pending' ? 'sending…' : `sent ✓${m.note ? ' · ' + m.note : ''}`) : `${m.sender || 'Support'}`
        return el('div', { class: `msg${mine ? ' me' : ''}` }, document.createTextNode(m.text || `[${m.kind}]`), el('span', { class: 'meta', text: `${meta} · ${clock(m.at)}` }))
      }),
    )
    if (atBottom) box.scrollTop = box.scrollHeight
    const open = !!(p && p.connected)
    $('draft').disabled = !open
    $('send').disabled = !open
    $('connect').disabled = !p || !!p.ws
    $('disconnect').disabled = !p || !p.ws
    $('drop').disabled = !p || !p.ws
    $('typing').disabled = !open
    $('send-again').disabled = !open || !p.lastSend
  }

  function renderWire() {
    const p = cur()
    $('wire-list').replaceChildren(
      ...(p ? p.wire.slice(-200) : []).map((w) => el('li', { class: w.cls }, document.createTextNode(`${clock(w.at)} ${w.dir === 'out' ? '→' : w.dir === 'in' ? '←' : '·'} ${w.text}`))),
    )
    const l = $('wire-list')
    l.scrollTop = l.scrollHeight
  }

  async function refreshPush() {
    const p = cur()
    if (!p) { $('push-list').replaceChildren(); return }
    const data = await api(`/push?wallet_id=${encodeURIComponent(p.wallet)}`)
    const badge = $('push-count')
    badge.hidden = data.alerts.length === 0
    badge.textContent = String(data.alerts.length)
    const items = data.alerts
      .slice()
      .reverse()
      .map((a) =>
        el(
          'li',
          { class: 'push' },
          el('div', { class: 'title', text: `${a.title} · ${a.body}` }),
          el('div', { class: 'muted small', text: `${clock(a.at)} · to ${a.phone || a.email} · mock answered "${a.result}"` }),
          el('code', { text: a.deep_link }),
          el('div', { class: 'row' }, el('button', { onclick: () => tap(p, a) }, 'Tap')),
        ),
      )
    const decisions = data.decisions
      .filter((d) => d.outcome !== 'sent')
      .slice(0, 6)
      .map((d) => el('li', { class: 'muted small', text: `${clock(d.created_at)} no alert: ${d.outcome}${d.detail ? ' (' + d.detail + ')' : ''}` }))
    $('push-list').replaceChildren(...(items.length ? items : [el('li', { class: 'muted', text: 'No alerts yet for this user.' })]), ...decisions)
  }

  async function tap(p, alert) {
    toast(`Opening ${alert.deep_link}`)
    if (!p.ws) await openApp(p)
  }

  const ticks = (m) => (m.status === 'read' ? el('span', { class: 'tick read', text: '✓✓' }) : m.status === 'delivered' ? el('span', { class: 'tick', text: '✓✓' }) : el('span', { class: 'tick', text: '✓' }))

  async function refreshAgent() {
    const p = cur()
    if (!p) { $('agent-list').replaceChildren(); return }
    const { messages } = await api(`/messages?wallet_id=${encodeURIComponent(p.wallet)}`)
    const box = $('agent-list')
    box.replaceChildren(
      ...messages.map((m) =>
        el(
          'li',
          { class: `a${m.direction === 'out' ? ' out' : ''}` },
          document.createTextNode(m.text || ''),
          el('span', { class: 'muted small' }, document.createTextNode(` ${clock(m.created_at)} `), m.direction === 'out' ? ticks(m) : null, m.direction === 'out' && m.delivery ? document.createTextNode(` ${m.delivery}`) : null),
        ),
      ),
    )
    box.scrollTop = box.scrollHeight
    return messages
  }

  async function refreshEvents() {
    const { events } = await api('/events')
    $('event-list').replaceChildren(
      ...(events.length ? events : []).map((e) =>
        el(
          'li',
          { class: 'event' },
          el('div', {}, el('strong', { text: e.kind }), document.createTextNode(' '), el('span', { class: `state-${e.state}`, text: e.state.replace('_', ' ') }), document.createTextNode(e.attempts ? ` · ${e.attempts} attempt${e.attempts > 1 ? 's' : ''}` : '')),
          el('div', { class: 'small', text: e.summary }),
          e.last_error ? el('div', { class: 'small muted', text: e.last_error }) : null,
          e.next_attempt_at && e.state === 'retrying' ? el('div', { class: 'small muted', text: `next try ${clock(e.next_attempt_at)}` }) : null,
          el('div', { class: 'row' }, el('code', { text: e.id }), el('button', { class: 'ghost', onclick: () => replay(e.id) }, 'Replay')),
        ),
      ),
    )
    if (events.length === 0) $('event-list').append(el('li', { class: 'muted', text: 'Nothing sent to Halo yet.' }))
    return events
  }

  async function replay(id) {
    try {
      const r = await api('/replay-event', 'POST', { event_id: id })
      toast(`Halo ${r.outcome === 'ok' ? 'accepted' : 'answered'}${r.http_status ? ' ' + r.http_status : ''}: ${String(r.answer).slice(0, 140)}`)
    } catch (e) { toast(e.message) }
  }

  async function refreshUsers() {
    const { users } = await api('/users')
    usersCache = users
    for (const u of users) phoneFor(u)
    if (!current && users.length) current = users[0].wallet_id
    render()
  }

  async function refreshTab() {
    try {
      if (tab === 'push') await refreshPush()
      else if (tab === 'agent') await refreshAgent()
      else if (tab === 'events') await refreshEvents()
    } catch { /* the poll tries again */ }
  }

  function select(wallet) {
    current = wallet
    render()
    refreshTab()
  }

  // ------------------------------------------------------------ actions

  async function createUser(name) {
    const u = await api('/users', 'POST', { name })
    await refreshUsers()
    select(u.wallet_id)
    return phones.get(u.wallet_id)
  }

  async function agentSend(wallet, text) {
    return api('/agent-message', 'POST', { wallet_id: wallet, text })
  }

  // ------------------------------------------------------------ scenarios

  const log = $('scenario-log')
  const head = (t) => log.append(el('li', { class: 'head', text: t }))
  async function step(text, fn) {
    const li = el('li', { class: 'run', text })
    log.append(li)
    li.scrollIntoView({ block: 'nearest' })
    try {
      const out = await fn()
      li.className = 'pass'
      return out
    } catch (e) {
      li.className = 'fail'
      li.textContent = `${text}: ${e.message}`
      throw e
    }
  }
  async function until(fn, ms, what) {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await sleep(150)
    }
  }
  const expect = (cond, msg) => { if (!cond) throw new Error(msg) }
  const phoneHas = (p, text) => p.msgs.some((m) => m.text === text)
  const alertsOf = async (p) => (await api(`/push?wallet_id=${encodeURIComponent(p.wallet)}`)).alerts
  const resetControls = () => { $('auto-ack').checked = true; $('ack-delay').value = '0'; $('screen-open').checked = true }

  const SCENARIOS = {
    'Agent replies while the app is open': async () => {
      const p = await step('Add a test user and open the app', async () => { const x = await createUser('Open app'); await openApp(x); await until(() => x.connected, 8000, 'the app to connect'); return x })
      const a = await step('Agent sends a message', () => agentSend(p.wallet, 'Hello from support'))
      await step('Gateway says it went over the live connection', () => expect(a.delivery === 'socket', `delivery was ${a.delivery}`))
      await step('The app receives it', () => until(() => phoneHas(p, 'Hello from support'), 4000, 'the message'))
      await step('The agent sees it delivered', () => until(async () => (await refreshAgent()).find((m) => m.server_id === a.server_id)?.status !== 'sent', 5000, 'delivered/read'))
      await step('No push is raised (waiting past the timeout)', async () => { await sleep(config.push.ack_timeout_ms + 2500); expect((await alertsOf(p)).length === 0, 'an alert was raised') })
    },
    'Agent replies while the app is closed': async () => {
      const p = await step('Add a test user (app closed)', () => createUser('Closed app'))
      const a = await step('Agent sends a message', () => agentSend(p.wallet, 'Are you there?'))
      await step('Gateway raised a push', () => expect(a.delivery === 'push', `delivery was ${a.delivery}`))
      const alerts = await step('The push inbox shows one alert, with generic text', async () => { const x = await alertsOf(p); expect(x.length === 1, `${x.length} alerts`); expect(!x[0].body.includes('Are you there'), 'the alert contains the message'); return x })
      await step('Tapping the alert opens the app and the message arrives (resume)', async () => { await tap(p, alerts[0]); await until(() => phoneHas(p, 'Are you there?'), 8000, 'the message') })
      await step('The agent sees it delivered', () => until(async () => (await refreshAgent()).find((m) => m.server_id === a.server_id)?.status !== 'sent', 5000, 'delivered/read'))
    },
    'Acknowledgement lost: push is the fallback': async () => {
      const p = await step('Add a test user and open the app', async () => { const x = await createUser('Lost ack'); await openApp(x); await until(() => x.connected, 8000, 'the app to connect'); return x })
      await step('Stop acknowledging deliveries', () => { $('auto-ack').checked = false })
      const a = await step('Agent sends a message', () => agentSend(p.wallet, 'Did this arrive?'))
      await step('It went over the connection', () => expect(a.delivery === 'socket', `delivery was ${a.delivery}`))
      await step(`A push follows once ${config.push.ack_timeout_ms / 1000} s pass without an acknowledgement`, () => until(async () => (await alertsOf(p)).length === 1, config.push.ack_timeout_ms + 6000, 'the push alert'))
      resetControls()
    },
    'Reconnect replays the gap': async () => {
      const p = await step('Add a test user and open the app', async () => { const x = await createUser('Gap'); await openApp(x); await until(() => x.connected, 8000, 'the app to connect'); return x })
      await step('Drop the connection', async () => { closeApp(p, 4000, 'simulated drop'); await until(() => !p.ws, 3000, 'the app to close') })
      await step('Agent sends three messages while it is away', async () => { for (const t of ['one', 'two', 'three']) await agentSend(p.wallet, t) })
      await step('Reconnect', async () => { await openApp(p); await until(() => p.connected, 8000, 'the app to connect') })
      await step('All three arrive, once each, in order', async () => {
        await until(() => p.msgs.filter((m) => m.direction === 'out').length >= 3, 6000, 'the three messages')
        const got = p.msgs.filter((m) => m.direction === 'out').map((m) => m.text)
        expect(JSON.stringify(got) === JSON.stringify(['one', 'two', 'three']), `got ${JSON.stringify(got)}`)
      })
    },
    'The same message sent twice': async () => {
      const p = await step('Add a test user and open the app', async () => { const x = await createUser('Duplicate'); await openApp(x); await until(() => x.connected, 8000, 'the app to connect'); return x })
      await step('Send "once"', async () => { sendText(p, 'once'); await until(() => p.msgs.some((m) => m.text === 'once' && m.state === 'sent'), 4000, 'the acknowledgement') })
      await step('Send it again with the same id: the gateway absorbs it', async () => {
        const before = p.wire.length
        expect(sendFrame(p, p.lastSend), 'not connected')
        await until(() => p.wire.slice(before).some((w) => w.dir === 'in' && w.text.includes('"duplicate":true')), 4000, 'a duplicate acknowledgement')
      })
      await step('Halo is told once', async () => {
        await sleep(1500)
        const n = (await api('/events')).events.filter((e) => e.kind === 'message.inbound' && e.summary.startsWith(p.wallet) && e.summary.includes('once')).length
        expect(n === 1, `${n} events for the same message`)
      })
    },
    'Halo is down, then back': async () => {
      const p = await step('Add a test user and open the app', async () => { const x = await createUser('Halo down'); await openApp(x); await until(() => x.connected, 8000, 'the app to connect'); return x })
      await step('Switch Halo off', () => setHaloOffline(true))
      await step('Send two messages from the app: the gateway still accepts them', async () => { sendText(p, 'first while down'); sendText(p, 'second while down'); await until(() => p.msgs.filter((m) => m.direction === 'in' && m.state === 'sent').length >= 2, 5000, 'both acknowledgements') })
      await step('The events wait and retry', () => until(async () => (await refreshEvents()).some((e) => e.summary.includes('while down') && e.state !== 'sent'), 6000, 'events waiting'))
      await step('Switch Halo back on', () => setHaloOffline(false))
      await step('Both are delivered to Halo, in order', async () => {
        const ours = () => api('/events').then((r) => r.events.filter((e) => e.summary.startsWith(p.wallet)).reverse())
        const evs = await until(async () => { const x = await ours(); return x.length >= 2 && x.every((e) => e.state === 'sent') ? x : null }, 20000, 'Halo to accept both')
        expect(evs[0].summary.includes('first') && evs[1].summary.includes('second'), 'the events went out of order')
      })
    },
  }

  async function runScenario(name, btn) {
    for (const b of document.querySelectorAll('#scenario-buttons button')) b.disabled = true
    log.replaceChildren()
    head(name)
    resetControls()
    try {
      await SCENARIOS[name]()
      head('All steps passed')
    } catch (e) {
      head(`Stopped: ${e.message}`)
    } finally {
      for (const b of document.querySelectorAll('#scenario-buttons button')) b.disabled = false
      resetControls()
    }
  }

  async function setHaloOffline(offline) {
    await api('/halo-offline', 'POST', { offline })
    $('halo-offline').checked = offline
    haloPill(offline)
  }
  function haloPill(offline) {
    const pill = $('halo-state')
    pill.className = `pill ${offline ? 'bad' : 'on'}`
    pill.textContent = offline ? 'Halo switched off' : `Halo: ${config.halo.host}`
  }

  // ------------------------------------------------------------ wiring

  function bind() {
    $('new-user').addEventListener('submit', async (e) => {
      e.preventDefault()
      try { await createUser($('new-name').value.trim()); $('new-name').value = '' } catch (err) { toast(err.message) }
    })
    $('composer').addEventListener('submit', (e) => {
      e.preventDefault()
      const text = $('draft').value.trim()
      const p = cur()
      if (!p || !text) return
      $('draft').value = ''
      sendText(p, text)
    })
    $('connect').addEventListener('click', () => { const p = cur(); if (p) openApp(p).catch((e) => toast(e.message)) })
    $('disconnect').addEventListener('click', () => { const p = cur(); if (p) closeApp(p) })
    $('drop').addEventListener('click', () => { const p = cur(); if (p) closeApp(p, 4000, 'simulated drop') })
    $('typing').addEventListener('click', () => { const p = cur(); if (p) sendFrame(p, { type: 'typing' }) })
    $('send-again').addEventListener('click', () => { const p = cur(); if (p && p.lastSend) sendFrame(p, p.lastSend) })
    $('screen-open').addEventListener('change', () => {
      const p = cur()
      if (!$('screen-open').checked || !p || !p.connected) return
      const top = Math.max(0, ...p.msgs.filter((m) => m.direction === 'out').map((m) => m.seq || 0))
      if (top) sendFrame(p, { type: 'receipt', up_to_seq: top, status: 'read' })
    })
    $('halo-offline').addEventListener('change', (e) => setHaloOffline(e.target.checked).catch((err) => toast(err.message)))
    $('reset').addEventListener('click', async () => {
      for (const p of phones.values()) closeApp(p)
      phones.clear(); current = null
      try { await api('/reset', 'POST', {}); await refreshUsers(); toast('Test users removed') } catch (e) { toast(e.message) }
    })
    $('agent-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const p = cur(); const text = $('agent-draft').value.trim()
      if (!p || !text) return
      try {
        const r = await agentSend(p.wallet, text)
        $('agent-draft').value = ''
        $('agent-result').textContent = `Gateway answered: delivery ${r.delivery}, seq ${r.seq}`
        refreshAgent()
      } catch (err) { $('agent-result').textContent = err.message }
    })
    $('wire-clear').addEventListener('click', () => { const p = cur(); if (p) { p.wire = []; renderWire() } })
    for (const b of document.querySelectorAll('.tabs button')) {
      b.addEventListener('click', () => {
        tab = b.dataset.tab
        for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('active', x === b)
        for (const pane of ['push', 'agent', 'events', 'wire']) $(`tab-${pane}`).hidden = pane !== tab
        if (tab === 'wire') renderWire()
        refreshTab()
      })
    }
    const sb = $('scenario-buttons')
    for (const name of Object.keys(SCENARIOS)) sb.append(el('button', { class: 'ghost', onclick: (e) => runScenario(name, e.target) }, name))
  }

  // ------------------------------------------------------------ start

  async function start() {
    let token = null
    const m = /[#&]t=([^&]+)/.exec(location.hash)
    if (m) {
      token = decodeURIComponent(m[1])
      history.replaceState(null, '', location.pathname) // the token is not left in the address bar
    }
    try { session = sessionStorage.getItem('vsim') } catch {}
    if (token) {
      try {
        const r = await fetch('/simulator/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
        const data = await r.json()
        if (!r.ok) { $('login').hidden = false; $('login').textContent = data?.error?.message || 'Could not start the simulator'; return }
        session = data.session
        try { sessionStorage.setItem('vsim', session) } catch {}
      } catch { $('login').hidden = false; $('login').textContent = 'Could not reach the gateway'; return }
    }
    if (!session) return endSession()
    try { config = await api('/config') } catch { return endSession() }
    $('login').hidden = true
    $('app').hidden = false
    $('ws-name').textContent = config.workspace.name
    $('halo-offline').checked = config.halo.offline
    haloPill(config.halo.offline)
    bind()
    await refreshUsers()
    setInterval(() => refreshUsers().catch(() => {}), 4000)
    setInterval(refreshTab, 1500)
    setInterval(() => { if (tab !== 'push') refreshPush().catch(() => {}) }, 4000)
  }

  start()
})()
