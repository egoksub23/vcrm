// ============================================================
// Settings, read once from the environment. Everything has a safe default
// except the two that cannot: the database and the encryption key.
// ============================================================

export interface Limits {
  /** Largest text message, in characters (contract: 4000). */
  textMax: number
  /** Largest caption on a file message. */
  captionMax: number
  /** Largest file, in bytes (Halo's ceiling: 16 MB). */
  fileMaxBytes: number
}

export interface GatewayConfig {
  port: number
  databaseUrl: string
  /** 64 hex characters; encrypts the stored webhook signing secrets. */
  encryptionKey: string
  /** Where the app connects (path on this server). */
  wsPath: string
  /** How long a connect token from POST /v1/sessions stays valid. */
  sessionTtlSeconds: number
  /** Seconds between heartbeats (the server pings; a client that misses two is dropped). */
  heartbeatSeconds: number
  /** How long a new connection may stay silent before it must say hello. */
  helloTimeoutMs: number
  /** Devices one user may have connected at once; the oldest is replaced. */
  maxDevicesPerUser: number
  /** Largest frame the socket accepts, in bytes. */
  maxFrameBytes: number
  /** Messages one user may send per window. */
  sendRateLimit: { limit: number; windowMs: number }
  /** Messages replayed per resume batch. */
  replayBatch: number
  /** How the outbox of events for Halo is sent. */
  dispatch: {
    /** Seconds between looks at the outbox (a new event also wakes it at once). */
    pollMs: number
    /** How long one call to Halo may take. */
    timeoutMs: number
    /** The longest wait between two tries of the same event. */
    maxBackoffMs: number
    /** An event Halo still has not accepted after this long is given up on and kept for inspection. */
    giveUpHours: number
  }
  /** The delivery decision: socket or push (src/delivery.ts). */
  push: {
    /** Which adapter calls the Vircle push API: `mock` records alerts and sends nothing; `vircle` is work package 8. */
    adapter: 'mock' | 'vircle'
    /** How long a live app has to acknowledge a message before the gateway alerts the user anyway. */
    ackTimeoutMs: number
    /** How often unacknowledged messages are looked at. */
    sweepMs: number
    /** A message still unacknowledged after this long raises no alert any more (the user can read it when they open the chat). */
    windowMinutes: number
    /** While one alert is outstanding, a reminder is allowed after this long if the user still has not come back. */
    realertHours: number
    /** Where tapping an alert goes; `{conversation_id}` and `{wallet_id}` are filled in. A workspace may override it (push_settings.deep_link). */
    deepLinkTemplate: string
  }
  /** The test page and its API under /simulator (staging and the pilot; switch it off for a production launch). */
  simulator: { enabled: boolean }
  /** Largest request body Halo may send (a message with its text). */
  maxHaloBodyBytes: number
  limits: Limits
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer of at least ${min}`)
  return n
}

function pushAdapter(raw: string | undefined): 'mock' | 'vircle' {
  if (raw === undefined || raw === '') return 'mock'
  if (raw === 'mock' || raw === 'vircle') return raw
  throw new Error('PUSH_ADAPTER must be mock or vircle')
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const encryptionKey = env.GATEWAY_ENCRYPTION_KEY
  if (!encryptionKey || !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    throw new Error('GATEWAY_ENCRYPTION_KEY is required: 64 hex characters (for example `openssl rand -hex 32`)')
  }
  return {
    port: int(env, 'PORT', 8090, 0),
    databaseUrl,
    encryptionKey,
    wsPath: env.GATEWAY_WS_PATH || '/ws',
    sessionTtlSeconds: int(env, 'SESSION_TTL_SECONDS', 60),
    heartbeatSeconds: int(env, 'HEARTBEAT_SECONDS', 25),
    helloTimeoutMs: int(env, 'HELLO_TIMEOUT_MS', 10_000),
    maxDevicesPerUser: int(env, 'MAX_DEVICES_PER_USER', 3),
    maxFrameBytes: int(env, 'MAX_FRAME_BYTES', 64 * 1024),
    sendRateLimit: { limit: int(env, 'SEND_RATE_LIMIT', 30), windowMs: int(env, 'SEND_RATE_WINDOW_MS', 10_000) },
    replayBatch: int(env, 'REPLAY_BATCH', 200),
    dispatch: {
      pollMs: int(env, 'DISPATCH_POLL_MS', 2000),
      timeoutMs: int(env, 'DISPATCH_TIMEOUT_MS', 10_000),
      maxBackoffMs: int(env, 'DISPATCH_MAX_BACKOFF_S', 900) * 1000,
      giveUpHours: int(env, 'DISPATCH_GIVE_UP_HOURS', 72),
    },
    push: {
      adapter: pushAdapter(env.PUSH_ADAPTER),
      ackTimeoutMs: int(env, 'PUSH_ACK_TIMEOUT_MS', 5000),
      sweepMs: int(env, 'PUSH_SWEEP_MS', 1000),
      windowMinutes: int(env, 'PUSH_WINDOW_MINUTES', 60),
      realertHours: int(env, 'PUSH_REALERT_HOURS', 24),
      deepLinkTemplate: env.PUSH_DEEP_LINK || 'vircle://chat/{conversation_id}',
    },
    simulator: { enabled: env.SIMULATOR_ENABLED === 'true' },
    maxHaloBodyBytes: int(env, 'MAX_HALO_BODY_BYTES', 64 * 1024),
    limits: {
      textMax: int(env, 'TEXT_MAX', 4000),
      captionMax: int(env, 'CAPTION_MAX', 1024),
      fileMaxBytes: int(env, 'FILE_MAX_BYTES', 16 * 1024 * 1024),
    },
  }
}

/** Defaults for tests and the simulator: no environment needed. */
export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    ...loadConfig({ DATABASE_URL: 'test', GATEWAY_ENCRYPTION_KEY: '00'.repeat(32) }),
    port: 0,
    ...overrides,
  }
}
