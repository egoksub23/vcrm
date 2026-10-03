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
  limits: Limits
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer of at least ${min}`)
  return n
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
