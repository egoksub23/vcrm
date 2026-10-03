// ============================================================
// Logging: one JSON object per line on stdout (stderr for errors), so `docker logs` can be searched with jq,
// shipped to any log service, and alerted on (`"level":"error"`). LOG_FORMAT=text is for reading at a terminal;
// LOG_LEVEL is debug | info | warn | error (default info). Silent under the test runner.
//
//   {"t":"2026-10-03T08:00:00.000Z","level":"warn","component":"dispatcher","msg":"Halo answered 503","workspace":"ws_1"}
//
// Never log a secret, a token, a message body or a phone number: ids and counts only.
// ============================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export type Fields = Record<string, unknown>

export interface Logger {
  debug(msg: string, fields?: Fields): void
  info(msg: string, fields?: Fields): void
  warn(msg: string, fields?: Fields): void
  error(msg: string, fields?: Fields): void
  /** The same logger with a component name on every line. */
  child(component: string): Logger
}

function levelFromEnv(raw: string | undefined): LogLevel {
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info'
}

export function createLogger(opts: { component?: string; level?: LogLevel; text?: boolean; silent?: boolean; write?: (level: LogLevel, line: string) => void } = {}): Logger {
  const min = ORDER[opts.level ?? levelFromEnv(process.env.LOG_LEVEL)]
  const text = opts.text ?? process.env.LOG_FORMAT === 'text'
  const silent = opts.silent ?? (process.env.VITEST !== undefined && process.env.GATEWAY_LOG_IN_TESTS !== '1')
  const write = opts.write ?? ((level, line) => (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n'))
  const emit = (level: LogLevel, msg: string, fields?: Fields) => {
    if (silent || ORDER[level] < min) return
    if (text) {
      const extra = fields && Object.keys(fields).length > 0 ? ' ' + JSON.stringify(fields) : ''
      write(level, `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${opts.component ? `[${opts.component}] ` : ''}${msg}${extra}`)
      return
    }
    write(level, JSON.stringify({ t: new Date().toISOString(), level, ...(opts.component ? { component: opts.component } : {}), msg, ...fields }))
  }
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (component) => createLogger({ ...opts, component, level: opts.level, text, silent, write }),
  }
}

/** The process-wide logger. */
export const log = createLogger()
