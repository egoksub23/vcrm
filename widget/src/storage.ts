// Tiny localStorage wrapper — every access is try/catch'd because the
// widget runs on arbitrary host pages (private mode, blocked storage,
// sandboxed WebViews) and must work fine without it.

function get(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function set(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* not remembered */
  }
}

/** This browser has chatted before — safe to reconnect quietly (unread badge) on page load. */
export const isReturning = (widgetToken: string): boolean => get(`vcw:returning:${widgetToken}`) === '1'
export const markReturning = (widgetToken: string): void => set(`vcw:returning:${widgetToken}`, '1')

/** created_at of the newest message this visitor has had on screen, per conversation. */
export const readLastSeen = (conversationId: string): string | null => get(`vcw:seen:${conversationId}`)
export const writeLastSeen = (conversationId: string, iso: string): void => set(`vcw:seen:${conversationId}`, iso)

/** The microphone this browser last used for a voice note (a deviceId), if any. */
export const readSavedMic = (): string | null => get('vcw:micId')
export const writeSavedMic = (deviceId: string): void => set('vcw:micId', deviceId)
