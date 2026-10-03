// Vircle Chat simulator (served by the gateway; docs/vircle-chat-gateway-scope.md, section 4).
// The pretend phone here runs on the SAME client library the app uses (client/src, loaded as /simulator/client.js), so what this
// page shows is what the app gets: connection, reconnect, resume, queueing, uploads, ticks, typing. This file is only the
// screen around it and the test tools (fault buttons, the agent side, scripted scenarios). All text from messages is written
// with textContent, never as HTML.
(() => {
  'use strict'

  const { VircleChatClient, memoryStore } = window.VircleChat

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
  let agentReply = null // the message the agent is replying to


  // ------------------------------------------------------------ composer: emoji, the attach menu, GIFs
  // The reference for the app's chat screen: the same three controls as WhatsApp and the web widget (emoji, "+" attach menu,
  // GIF) in front of the client library's sendText / sendFile / sendGif.

  const PICK = {
    document: { accept: 'application/pdf,text/plain,.doc,.docx,.xls,.xlsx,.ppt,.pptx' },
    media: { accept: 'image/png,image/jpeg,image/webp,video/mp4,video/3gpp' },
    camera: { accept: 'image/*,video/*', capture: 'environment' },
    audio: { accept: 'audio/ogg,audio/mpeg,audio/aac,audio/mp4,audio/amr' },
  }
  const PANELS = { attach: 'attach-menu', emoji: 'emoji-panel' }
  let panel = null

  function showPanel(name) {
    panel = panel === name ? null : name
    for (const [key, id] of Object.entries(PANELS)) $(id).hidden = key !== panel
    if (panel === 'emoji') { buildEmoji(); $('emoji-search').focus() }
  }

  function pickFile({ accept, capture }) {
    return new Promise((resolve) => {
      const input = el('input', { type: 'file', accept, hidden: '' })
      if (capture) input.setAttribute('capture', capture)
      input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove() })
      input.addEventListener('cancel', () => { resolve(null); input.remove() })
      document.body.append(input)
      input.click()
    })
  }

  /** What every send does with the draft: it becomes the caption, and a reply in progress is used up. */
  function takeDraft(p) {
    const caption = $('draft').value.trim()
    $('draft').value = ''
    const replyTo = p.replyTo
    p.replyTo = null
    return { caption, replyTo: replyTo || undefined }
  }
  const sendFailed = (err) => toast(`${err.code || 'error'}: ${err.message}`)

  async function sendPicked(file) {
    const p = cur()
    if (!p || !file) return
    const { caption, replyTo } = takeDraft(p)
    // A .gif chosen from the device is refused by the library with a clear reason: GIFs go through the GIF button as MP4.
    p.client.sendFile({ blob: file, name: file.name, type: file.type }, { caption, replyTo, durationSeconds: await audioDuration(file) }).catch(sendFailed)
  }

  // ---- emoji (the web widget's own list: window.__vircleWidgetLazy.emoji)
  let emojiBuilt = false
  function buildEmoji() {
    if (emojiBuilt) return
    const data = window.__vircleWidgetLazy && window.__vircleWidgetLazy.emoji
    if (!data) { $('emoji-grid').textContent = 'The emoji list did not load.'; return }
    emojiBuilt = true
    const groups = data.groups
    const grid = $('emoji-grid')
    const tabs = $('emoji-tabs')
    const insert = (emoji) => {
      const d = $('draft')
      const at = d.selectionStart == null ? d.value.length : d.selectionStart
      d.setRangeText(emoji, at, d.selectionEnd == null ? at : d.selectionEnd, 'end')
      d.focus()
      d.dispatchEvent(new Event('input'))
    }
    const show = (items) => grid.replaceChildren(...items.map(([emoji, words]) => el('button', { type: 'button', title: words.split(' ').slice(0, 4).join(' '), text: emoji, onclick: () => insert(emoji) })))
    const choose = (i) => {
      for (const [n, b] of [...tabs.children].entries()) b.classList.toggle('on', n === i)
      $('emoji-search').value = ''
      show(groups[i].items)
    }
    tabs.replaceChildren(...groups.map((g, i) => el('button', { type: 'button', title: g.key, text: g.items[0][0], onclick: () => choose(i) })))
    $('emoji-search').addEventListener('input', () => {
      const q = $('emoji-search').value.trim().toLowerCase()
      if (!q) return choose(0)
      for (const b of tabs.children) b.classList.remove('on')
      show(groups.flatMap((g) => g.items).filter(([, words]) => words.includes(q)).slice(0, 120))
    })
    choose(0)
  }

  // ---- GIFs: the app has no picker; it only has to SHOW one that arrives (an MP4 flagged animated: muted loop, no controls).
  // The Agent tab sends a sample one so that can be seen.

  /** A short looping MP4 made in this browser (canvas + MediaRecorder), so the whole path can be tried without any GIF service. */
  async function makeSampleMp4(emoji) {
    const type = ['video/mp4;codecs=avc1', 'video/mp4'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t))
    if (!type) throw new Error('This browser cannot record MP4. Use Chrome.')
    const canvas = el('canvas', { width: '240', height: '240' })
    const ctx = canvas.getContext('2d')
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: type })
    const chunks = []
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    const done = new Promise((resolve) => (recorder.onstop = resolve))
    recorder.start()
    const t0 = performance.now()
    // A timer, not requestAnimationFrame: a page in the background gets no animation frames, and the recording would never end.
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        const t = (performance.now() - t0) / 1500
        ctx.fillStyle = `hsl(${Math.round(Math.min(t, 1) * 360)}, 70%, 85%)`
        ctx.fillRect(0, 0, 240, 240)
        ctx.font = '96px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(emoji, 120, 120 + Math.sin(Math.min(t, 1) * Math.PI * 4) * 40)
        if (t >= 1) { clearInterval(timer); resolve() }
      }, 33)
    })
    recorder.stop()
    await done
    return new Blob(chunks, { type: 'video/mp4' })
  }

  function bindComposer() {
    $('attach').addEventListener('click', () => showPanel('attach'))
    $('emoji-btn').addEventListener('click', () => showPanel('emoji'))
    for (const b of document.querySelectorAll('#attach-menu [data-pick]')) {
      b.addEventListener('click', async () => {
        const what = b.getAttribute('data-pick')
        showPanel('attach') // closes the menu, then the system picker opens
        await sendPicked(await pickFile(PICK[what]))
      })
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel) showPanel(panel) })
  }

  // ------------------------------------------------------------ API

  async function api(path, method = 'GET', body, headers = {}) {
    const raw = body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array
    const res = await fetch(`/simulator/api${path}`, {
      method,
      headers: { ...(raw ? {} : { 'content-type': 'application/json' }), 'x-sim-session': session || '', ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
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

  // ------------------------------------------------------------ phones: one library client per test user

  function phoneFor(u) {
    let p = phones.get(u.wallet_id)
    if (p) return p
    p = { wallet: u.wallet_id, name: u.name, phone: u.phone, email: u.email, wire: [], socket: null, lastSend: null, replyTo: null, client: null }
    // The test tools sit between the app and the network, exactly where a real network would: they can swallow or delay what the app
    // sends (receipts) and cut the socket without telling the library.
    class TrackedSocket extends WebSocket {
      constructor(url) { super(url); p.socket = this }
    }
    p.client = new VircleChatClient({
      deviceId: 'sim-browser',
      appVersion: 'simulator',
      baseUrl: location.origin,
      WebSocket: TrackedSocket,
      store: memoryStore(),
      backoff: { minMs: 1500, maxMs: 8000, factor: 2, jitter: 0.2 },
      getSession: async () => {
        const t = await api('/connect-token', 'POST', { wallet_id: p.wallet })
        return { token: t.token, wsPath: t.ws_path }
      },
      interceptSend: (frame) => {
        if (frame.type === 'send') p.lastSend = frame
        if (frame.type === 'receipt') {
          if (!$('auto-ack').checked) return 'drop'
          return Number($('ack-delay').value) || 'send'
        }
        return 'send'
      },
    })
    p.client.on('wire', ({ direction, frame }) => wire(p, direction, JSON.stringify(frame), frame.type === 'error' ? 'err' : direction))
    p.client.on('state', (s) => wire(p, 'sys', `Connection: ${s}`, s === 'offline' || s === 'replaced' ? 'err' : 'sys'))
    p.client.on('error', (e) => toast(`${e.code}: ${e.message}`))
    p.client.subscribe(() => { if (p.wallet === current) render() })
    phones.set(u.wallet_id, p)
    return p
  }
  const cur = () => (current ? phones.get(current) : null)
  const snap = (p) => p.client.getSnapshot()
  const msgs = (p) => snap(p).messages

  function wire(p, dir, text, cls = '') {
    p.wire.push({ at: new Date().toISOString(), dir, text, cls: cls || dir })
    if (p.wire.length > 300) p.wire.shift()
    if (p === cur() && tab === 'wire') renderWire()
  }

  const openApp = async (p) => { p.client.setScreenOpen($('screen-open').checked); await p.client.start() }
  const closeApp = (p) => p.client.stop()
  /** Cut the connection without a goodbye: the library notices, shows it, and reconnects by itself. */
  const dropSocket = (p) => { try { p.socket && p.socket.close(4000, 'simulated drop') } catch {} }
  const isOnline = (p) => snap(p).state === 'online'

  async function audioDuration(file) {
    if (!file.type.startsWith('audio/')) return undefined
    return new Promise((resolve) => {
      const a = new Audio()
      a.preload = 'metadata'
      a.onloadedmetadata = () => resolve(Number.isFinite(a.duration) ? Math.round(a.duration) : undefined)
      a.onerror = () => resolve(undefined)
      a.src = URL.createObjectURL(file)
    })
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
        const online = p ? isOnline(p) : u.online
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

  const TICK = { sending: 'sending…', sent: '✓ sent', delivered: '✓✓ delivered', read: '✓✓ read', failed: 'not sent' }

  function quoteBlock(q) {
    if (!q) return null
    const label = q.from === 'you' ? 'You' : 'Support'
    return el('div', { class: 'quote' }, el('strong', { text: label }), document.createTextNode(` ${q.text || `[${q.kind}]`}`))
  }

  function mediaBlock(m) {
    const media = m.media
    if (!media) return null
    const url = media.url
    if (!url) return el('div', { class: 'small muted', text: `[${m.kind}] ${media.fileName || ''}` })
    if (m.kind === 'image') return el('img', { class: 'att', src: url, alt: media.fileName || 'image' })
    if (m.kind === 'video' && media.animated) {
      // A GIF: a muted loop with no controls, as on WhatsApp.
      const v = el('video', { class: 'gif', src: url, autoplay: '', loop: '', playsinline: '', 'aria-label': 'GIF' })
      v.muted = true
      return el('span', { class: 'gifwrap' }, el('span', { class: 'gif-tag', text: 'GIF' }), v)
    }
    if (m.kind === 'video') return el('video', { class: 'att', src: url, controls: '' })
    if (m.kind === 'audio') return el('div', {}, el('audio', { src: url, controls: '' }), media.durationSeconds ? el('div', { class: 'small muted', text: `voice note · ${media.durationSeconds}s` }) : null)
    return el('a', { href: url, target: '_blank', rel: 'noopener', text: `${media.fileName || 'document'} (${Math.max(1, Math.round((media.sizeBytes || 0) / 1024))} KB)` })
  }

  const CONN = { online: ['on', 'App open'], connecting: ['off', 'Connecting…'], offline: ['bad', 'Offline, retrying'], replaced: ['bad', 'Replaced'], stopped: ['off', 'App closed'], idle: ['off', 'App closed'] }

  function renderPhone() {
    const p = cur()
    $('phone-name').textContent = p ? p.name || p.wallet : 'No user selected'
    $('phone-sub').textContent = p ? `${p.wallet} · ${p.phone || ''}` : 'Add a test user, then open the app'
    const s = p ? snap(p) : null
    if (p && s && s.unreadCount) $('phone-sub').textContent += ` · ${s.unreadCount} unread (badge)`
    const [cls, label] = CONN[s ? s.state : 'idle']
    const conn = $('conn')
    conn.className = `pill ${cls}`
    conn.textContent = label
    const box = $('messages')
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
    const items = (s ? s.messages : []).map((m) => {
      const bubble = el('div', { class: `msg${m.mine ? ' me' : ''}${m.status === 'failed' ? ' failed' : ''}` })
      const q = quoteBlock(m.replyTo)
      if (q) bubble.append(q)
      const media = mediaBlock(m)
      if (media) bubble.append(media)
      if (m.text) bubble.append(document.createTextNode(m.text))
      const meta = m.mine ? `${TICK[m.status] || m.status}${m.error ? ': ' + m.error.code : ''}` : m.sender || 'Support'
      bubble.append(
        el(
          'span',
          { class: 'meta' },
          document.createTextNode(`${meta} · ${clock(m.sentAt)} `),
          m.serverId ? el('button', { class: 'link', title: 'Reply to this message', onclick: () => { p.replyTo = m; render(); $('draft').focus() } }, '↩ reply') : null,
          m.status === 'failed' ? el('button', { class: 'link', onclick: () => p.client.retry(m.id).catch(() => {}) }, ' retry') : null,
          m.status === 'failed' ? el('button', { class: 'link', onclick: () => p.client.discard(m.id) }, ' discard') : null,
        ),
      )
      return bubble
    })
    if (s && s.supportTyping) items.push(el('div', { class: 'sys typing', text: 'Support is typing…' }))
    box.replaceChildren(...items)
    if (atBottom) box.scrollTop = box.scrollHeight
    $('reply-bar').hidden = !(p && p.replyTo)
    if (p && p.replyTo) $('reply-text').textContent = `Replying to ${p.replyTo.mine ? 'yourself' : 'Support'}: ${p.replyTo.text || `[${p.replyTo.kind}]`}`
    const open = !!s && s.state === 'online'
    const active = !!s && (s.state === 'online' || s.state === 'connecting' || s.state === 'offline')
    // Writing while offline is allowed (the library queues), so the composer works whenever the app is started.
    $('draft').disabled = !active
    $('send').disabled = !active
    $('attach').disabled = !active
    $('emoji-btn').disabled = !active
    $('connect').disabled = !p || active
    $('disconnect').disabled = !p || !active
    $('drop').disabled = !open
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

  /** What tapping an alert does in the app: open it (and the library takes what it missed). */
  async function tap(p, alert) {
    toast(`Opening ${alert.deep_link}`)
    if (!['online', 'connecting'].includes(snap(p).state)) await openApp(p)
    else p.client.reconnectNow()
  }

  const ticks = (m) => (m.status === 'read' ? el('span', { class: 'tick read', text: '✓✓' }) : m.status === 'delivered' ? el('span', { class: 'tick', text: '✓✓' }) : el('span', { class: 'tick', text: '✓' }))

  async function refreshAgent() {
    const p = cur()
    if (!p) { $('agent-list').replaceChildren(); return }
    const { messages } = await api(`/messages?wallet_id=${encodeURIComponent(p.wallet)}`)
    const box = $('agent-list')
    box.replaceChildren(
      ...messages.map((m) => {
        const row = el('li', { class: `a${m.direction === 'out' ? ' out' : ''}` })
        if (m.reply_to) row.append(quoteBlock({ from: m.reply_to.from, text: m.reply_to.text, kind: m.reply_to.kind }))
        if (m.media && m.media.url) {
          if (m.kind === 'image') row.append(el('img', { class: 'att', src: m.media.url, alt: m.media.file_name || 'image' }))
          else if (m.kind === 'video') {
            const v = el('video', { class: m.media.animated ? 'gif' : 'att', src: m.media.url, ...(m.media.animated ? { autoplay: '', loop: '', playsinline: '' } : { controls: '' }) })
            if (m.media.animated) v.muted = true
            row.append(v)
            if (m.media.animated) row.append(el('span', { class: 'small muted', text: ' GIF' }))
          }
          else row.append(el('a', { href: m.media.url, target: '_blank', rel: 'noopener', text: `${m.kind}: ${m.media.file_name || 'file'}` }))
        }
        if (m.text) row.append(document.createTextNode(m.text))
        row.append(
          el(
            'span',
            { class: 'muted small' },
            document.createTextNode(` ${clock(m.created_at)} `),
            m.direction === 'in' ? ticks(m) : null,
            m.direction === 'out' && m.delivery ? document.createTextNode(` ${m.delivery}`) : null,
            document.createTextNode(' '),
            el('button', { class: 'link', title: 'Reply to this message', onclick: () => { agentReply = m; $('agent-reply-text').textContent = `Replying to: ${m.text || `[${m.kind}]`}`; $('agent-reply-bar').hidden = false } }, '↩ reply'),
          ),
        )
        return row
      }),
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
    agentReply = null
    $('agent-reply-bar').hidden = true
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

  async function agentSend(wallet, text, replyTo) {
    return api('/agent-message', 'POST', { wallet_id: wallet, text, ...(replyTo ? { reply_to_server_id: replyTo } : {}) })
  }

  async function agentSendFile(wallet, file, caption, replyTo, durationSeconds, animated) {
    return api('/agent-file', 'POST', file, {
      'content-type': file.type,
      'x-wallet-id': wallet,
      'x-file-name': encodeURIComponent(file.name),
      ...(caption ? { 'x-caption': encodeURIComponent(caption) } : {}),
      ...(replyTo ? { 'x-reply-to': replyTo } : {}),
      ...(durationSeconds ? { 'x-duration': String(durationSeconds) } : {}),
      ...(animated ? { 'x-animated': '1' } : {}),
    })
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
  const phoneHas = (p, text) => msgs(p).some((m) => m.text === text)
  const find = (p, text) => msgs(p).find((m) => m.text === text)
  const alertsOf = async (p) => (await api(`/push?wallet_id=${encodeURIComponent(p.wallet)}`)).alerts
  const resetControls = () => { $('auto-ack').checked = true; $('ack-delay').value = '0'; $('screen-open').checked = true }
  const openUser = async (name) => { const x = await createUser(name); await openApp(x); await until(() => isOnline(x), 8000, 'the app to connect'); return x }
  const stored = (m) => m && (m.status === 'sent' || m.status === 'delivered' || m.status === 'read')

  /** A small real PNG (a coloured square), made in the page. */
  async function samplePng() {
    const c = document.createElement('canvas')
    c.width = c.height = 48
    const g = c.getContext('2d')
    g.fillStyle = '#1b5e9e'
    g.fillRect(0, 0, 48, 48)
    g.fillStyle = '#fff'
    g.fillRect(12, 12, 24, 24)
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
    return new File([blob], 'sample.png', { type: 'image/png' })
  }
  /** Bytes that are an Ogg file as far as the gateway can tell (not playable: the point is the voice-note path). */
  const sampleVoice = () => new File([new Uint8Array([79, 103, 103, 83, ...new Array(300).fill(1)])], 'voice.ogg', { type: 'audio/ogg' })

  const SCENARIOS = {
    'Agent replies while the app is open': async () => {
      const p = await step('Add a test user and open the app', () => openUser('Open app'))
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
      const p = await step('Add a test user and open the app', () => openUser('Lost ack'))
      await step('Stop acknowledging deliveries', () => { $('auto-ack').checked = false })
      const a = await step('Agent sends a message', () => agentSend(p.wallet, 'Did this arrive?'))
      await step('It went over the connection', () => expect(a.delivery === 'socket', `delivery was ${a.delivery}`))
      await step(`A push follows once ${config.push.ack_timeout_ms / 1000} s pass without an acknowledgement`, () => until(async () => (await alertsOf(p)).length === 1, config.push.ack_timeout_ms + 6000, 'the push alert'))
      resetControls()
    },
    'Reconnect replays the gap': async () => {
      const p = await step('Add a test user and open the app', () => openUser('Gap'))
      await step('Drop the connection (the library notices and starts to reconnect)', async () => { dropSocket(p); await until(() => !isOnline(p), 3000, 'the connection to drop') })
      await step('Agent sends three messages while it is away', async () => { for (const t of ['one', 'two', 'three']) await agentSend(p.wallet, t) })
      await step('The library reconnects by itself', () => until(() => isOnline(p), 10000, 'the app to reconnect'))
      await step('All three arrive, once each, in order', async () => {
        await until(() => msgs(p).filter((m) => !m.mine).length >= 3, 6000, 'the three messages')
        const got = msgs(p).filter((m) => !m.mine).map((m) => m.text)
        expect(JSON.stringify(got) === JSON.stringify(['one', 'two', 'three']), `got ${JSON.stringify(got)}`)
      })
    },
    'The same message sent twice': async () => {
      const p = await step('Add a test user and open the app', () => openUser('Duplicate'))
      await step('Send "once"', async () => { const m = await p.client.sendText('once'); expect(stored(m), `status ${m.status}`) })
      await step('Send it again with the same id: the gateway absorbs it', async () => {
        const before = p.wire.length
        expect(p.lastSend && p.socket && p.socket.readyState === 1, 'not connected')
        p.socket.send(JSON.stringify(p.lastSend))
        await until(() => p.wire.slice(before).some((w) => w.dir === 'in' && w.text.includes('"duplicate":true')), 4000, 'a duplicate acknowledgement')
      })
      await step('Halo is told once', async () => {
        await sleep(1500)
        const n = (await api('/events')).events.filter((e) => e.kind === 'message.inbound' && e.summary.startsWith(p.wallet) && e.summary.includes('once')).length
        expect(n === 1, `${n} events for the same message`)
      })
    },
    'Halo is down, then back': async () => {
      const p = await step('Add a test user and open the app', () => openUser('Halo down'))
      await step('Switch Halo off', () => setHaloOffline(true))
      await step('Send two messages from the app: the gateway still accepts them', async () => { await Promise.all([p.client.sendText('first while down'), p.client.sendText('second while down')]) })
      await step('The events wait and retry', () => until(async () => (await refreshEvents()).some((e) => e.summary.includes('while down') && e.state !== 'sent'), 6000, 'events waiting'))
      await step('Switch Halo back on', () => setHaloOffline(false))
      await step('Both are delivered to Halo, in order', async () => {
        const ours = () => api('/events').then((r) => r.events.filter((e) => e.summary.startsWith(p.wallet)).reverse())
        const evs = await until(async () => { const x = await ours(); return x.length >= 2 && x.every((e) => e.state === 'sent') ? x : null }, 20000, 'Halo to accept both')
        expect(evs[0].summary.includes('first') && evs[1].summary.includes('second'), 'the events went out of order')
      })
    },
    'Photos and voice notes, both ways': async () => {
      const p = await step('Add a test user and open the app', () => openUser('Files'))
      const png = await samplePng()
      await step('The app sends a photo with a caption (slot, upload, send)', async () => {
        const m = await p.client.sendFile({ blob: png, name: png.name, type: png.type }, { caption: 'my receipt' })
        expect(stored(m) && m.media && m.media.fileId, 'the photo was not stored')
      })
      await step('The agent sees the photo with its caption', () => until(async () => (await refreshAgent()).some((m) => m.kind === 'image' && m.direction === 'in' && m.text === 'my receipt' && m.media && m.media.url), 5000, 'the photo'))
      await step('The app sends a voice note with its length', async () => {
        const v = sampleVoice()
        const m = await p.client.sendFile({ blob: v, name: v.name, type: v.type }, { durationSeconds: 6 })
        expect(stored(m) && m.media.durationSeconds === 6, 'the voice note was not stored with its length')
      })
      await step('The agent sends a photo back', async () => { const a = await agentSendFile(p.wallet, png, 'here is the form'); expect(a.delivery === 'socket', `delivery was ${a.delivery}`) })
      await step('It arrives in the app with a link that serves the file', async () => {
        const m = await until(() => msgs(p).find((x) => !x.mine && x.kind === 'image'), 5000, 'the photo')
        const url = await p.client.getMediaUrl(m.id)
        const got = await fetch(url)
        expect(got.ok && got.headers.get('content-type') === 'image/png', `the link answered ${got.status} ${got.headers.get('content-type')}`)
      })
      await step('A file type that is not allowed is refused before any upload', async () => {
        let code = null
        try { await p.client.sendFile({ blob: new Blob([new Uint8Array(20)], { type: 'application/zip' }), name: 'x.zip' }) } catch (e) { code = e.code }
        expect(code === 'file_type_not_allowed', `code was ${code}`)
      })
    },
    'Emoji and GIFs': async () => {
      const p = await step('Add a test user and open the app', () => openUser('Emoji'))
      const text = '👍🏽 👨‍👩‍👧‍👦 🇲🇾 1️⃣ ❤️‍🔥 😀 你好 안녕'
      await step('The app sends emoji of every kind (skin tone, family, flag, keycap)', async () => { const m = await p.client.sendText(text); expect(stored(m), 'the message was not stored') })
      await step('The agent sees the very same characters', () => until(async () => (await refreshAgent()).some((m) => m.direction === 'in' && m.text === text), 5000, 'the emoji'))
      await step('The agent answers with emoji, and they arrive unchanged', async () => { await agentSend(p.wallet, 'On it 🙏 ✅'); await until(() => find(p, 'On it 🙏 ✅'), 4000, 'the answer') })
      await step('The agent sends a GIF (a looping MP4 flagged animated, as WhatsApp does)', async () => {
        const mp4 = await makeSampleMp4('🎉')
        const a = await agentSendFile(p.wallet, new File([mp4], 'party.mp4', { type: 'video/mp4' }), '', null, 0, true)
        expect(a.delivery === 'socket', `delivery was ${a.delivery}`)
      })
      await step('It arrives in the app flagged animated, so the screen plays it as a muted loop', () => until(() => msgs(p).find((m) => !m.mine && m.kind === 'video' && m.media && m.media.animated === true), 5000, 'the GIF'))
      await step('A .gif file is refused by the library with the reason, and nothing is uploaded', async () => {
        let code = null
        try { await p.client.sendFile({ blob: new Blob([new Uint8Array(20)], { type: 'image/gif' }), name: 'x.gif' }) } catch (e) { code = e.code }
        expect(code === 'gif_must_be_mp4', `code was ${code}`)
      })
    },
    'A reply quotes the message': async () => {
      const p = await step('Add a test user and open the app', () => openUser('Quote'))
      const q = await step('The agent asks something', () => agentSend(p.wallet, 'Which account do you want to close?'))
      const asked = await step('The app has it', () => until(() => msgs(p).find((m) => m.serverId === q.server_id), 4000, 'the question'))
      await step('The app answers, quoting it', async () => { const m = await p.client.sendText('The savings one', { replyTo: asked }); expect(m.replyTo && m.replyTo.serverId === q.server_id, 'the answer carries no quote') })
      await step('The agent sees the answer as a reply to the question', () => until(async () => (await refreshAgent()).some((m) => m.text === 'The savings one' && m.reply_to && m.reply_to.server_id === q.server_id), 5000, 'the quote'))
      await step('The agent replies to that answer, and the app shows the quote', async () => {
        const answer = (await refreshAgent()).find((m) => m.text === 'The savings one')
        await agentSend(p.wallet, 'Done, it is closed', answer.server_id)
        await until(() => { const m = find(p, 'Done, it is closed'); return m && m.replyTo && m.replyTo.text === 'The savings one' && m.replyTo.from === 'you' }, 4000, 'the quoted reply')
      })
    },
    'Ticks: delivered, then read': async () => {
      const p = await step('Add a test user and open the app', () => openUser('Ticks'))
      await step('The app sends a message', async () => { const m = await p.client.sendText('please check my account'); expect(stored(m), `status ${m.status}`) })
      await step('It shows delivered once Halo has accepted it', () => until(() => { const m = find(p, 'please check my account'); return m && (m.status === 'delivered' || m.status === 'read') }, 15000, 'delivered (needs Halo to be reachable)'))
      await step('When an agent reads it, the app shows read', async () => {
        const r = await api('/agent-read', 'POST', { wallet_id: p.wallet })
        expect(r.updated >= 1, 'nothing was marked read')
        await until(() => { const m = find(p, 'please check my account'); return m && m.status === 'read' }, 4000, 'the read tick')
      })
    },
    'Typing indicators': async () => {
      const p = await step('Add a test user and open the app', () => openUser('Typing'))
      await step('An agent starts typing: the app shows it', async () => { await api('/agent-typing', 'POST', { wallet_id: p.wallet }); await until(() => snap(p).supportTyping, 4000, 'the typing line') })
      await step('The typing line goes away by itself', () => until(() => !snap(p).supportTyping, 9000, 'the line to clear'))
      await step('The app types: a typing frame goes to the gateway (and on to Halo)', async () => {
        const before = p.wire.length
        p.client.typing()
        expect(p.wire.slice(before).some((w) => w.dir === 'out' && w.text.includes('"typing"')), 'no typing frame was sent')
      })
    },
  }

  async function runScenario(name) {
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
      const replyTo = p.replyTo
      p.replyTo = null
      p.client.sendText(text, { replyTo: replyTo || undefined }).catch((err) => toast(`${err.code || 'error'}: ${err.message}`))
    })
    // The library throttles this itself (at most every 2.5 seconds).
    $('draft').addEventListener('input', () => { const p = cur(); if (p && $('draft').value) p.client.typing() })
    bindComposer()
    $('reply-cancel').addEventListener('click', () => { const p = cur(); if (p) { p.replyTo = null; render() } })
    $('connect').addEventListener('click', () => { const p = cur(); if (p) openApp(p).catch((e) => toast(e.message)) })
    $('disconnect').addEventListener('click', () => { const p = cur(); if (p) closeApp(p) })
    $('drop').addEventListener('click', () => { const p = cur(); if (p) dropSocket(p) })
    $('typing').addEventListener('click', () => { const p = cur(); if (p) p.client.typing() })
    $('send-again').addEventListener('click', () => { const p = cur(); if (p && p.lastSend && p.socket && p.socket.readyState === 1) p.socket.send(JSON.stringify(p.lastSend)) })
    $('screen-open').addEventListener('change', () => { const p = cur(); if (p) p.client.setScreenOpen($('screen-open').checked) })
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
        const r = await agentSend(p.wallet, text, agentReply && agentReply.server_id)
        $('agent-draft').value = ''
        agentReply = null
        $('agent-reply-bar').hidden = true
        $('agent-result').textContent = `Gateway answered: delivery ${r.delivery}, seq ${r.seq}`
        refreshAgent()
      } catch (err) { $('agent-result').textContent = err.message }
    })
    let lastAgentTyping = 0
    $('agent-draft').addEventListener('input', () => {
      const p = cur()
      if (!p || Date.now() - lastAgentTyping < 2500) return
      lastAgentTyping = Date.now()
      api('/agent-typing', 'POST', { wallet_id: p.wallet }).catch(() => {})
    })
    $('agent-attach').addEventListener('click', () => $('agent-file').click())
    $('agent-gif').addEventListener('click', async () => {
      const p = cur()
      if (!p) return toast('Add a test user first')
      try {
        const mp4 = await makeSampleMp4('🎉')
        mp4.name = 'party.mp4'
        const a = await agentSendFile(p.wallet, new File([mp4], 'party.mp4', { type: 'video/mp4' }), '', agentReply && agentReply.server_id, 0, true)
        toast(`GIF sent as the agent (${a.delivery})`)
      } catch (err) { toast(err.message) }
    })
    $('agent-file').addEventListener('change', async () => {
      const p = cur()
      const file = $('agent-file').files[0]
      $('agent-file').value = ''
      if (!p || !file) return
      try {
        const r = await agentSendFile(p.wallet, file, $('agent-draft').value.trim(), agentReply && agentReply.server_id, await audioDuration(file))
        $('agent-draft').value = ''
        agentReply = null
        $('agent-reply-bar').hidden = true
        $('agent-result').textContent = `Gateway answered: delivery ${r.delivery}, seq ${r.seq}`
        refreshAgent()
      } catch (err) { $('agent-result').textContent = err.message }
    })
    $('agent-read').addEventListener('click', async () => {
      const p = cur()
      if (!p) return
      try { const r = await api('/agent-read', 'POST', { wallet_id: p.wallet }); $('agent-result').textContent = `Marked ${r.updated} message(s) read`; refreshAgent() } catch (err) { $('agent-result').textContent = err.message }
    })
    $('agent-reply-cancel').addEventListener('click', () => { agentReply = null; $('agent-reply-bar').hidden = true })
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
    for (const name of Object.keys(SCENARIOS)) sb.append(el('button', { class: 'ghost', onclick: () => runScenario(name) }, name))
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
