// ============================================================
// Who is connected right now. The gateway decides socket-or-push from this: a
// user with at least one live connection can be sent to directly; a user with
// none is offline. The registry lives in memory (one gateway instance carries
// the pilot); everything that must survive a restart is in the database.
// ============================================================

export interface LiveConnection {
  readonly id: string
  readonly userId: string
  readonly deviceId: string
  send(frame: Record<string, unknown>): void
  close(code: number, reason: string): void
}

export class Hub {
  private readonly byUser = new Map<string, LiveConnection[]>()

  constructor(private readonly maxDevicesPerUser: number) {}

  /** Register a connection. Returns the connections it pushed out (the same device reconnecting, or the oldest over the limit). */
  add(conn: LiveConnection): LiveConnection[] {
    const list = this.byUser.get(conn.userId) ?? []
    const evicted: LiveConnection[] = []
    // The same device connecting again replaces its earlier connection (a reconnect the server has not noticed yet).
    for (const existing of [...list]) {
      if (existing.deviceId === conn.deviceId) {
        evicted.push(existing)
        list.splice(list.indexOf(existing), 1)
      }
    }
    list.push(conn)
    while (list.length > this.maxDevicesPerUser) evicted.push(list.shift()!)
    this.byUser.set(conn.userId, list)
    return evicted
  }

  remove(conn: LiveConnection): void {
    const list = this.byUser.get(conn.userId)
    if (!list) return
    const next = list.filter((c) => c !== conn)
    if (next.length === 0) this.byUser.delete(conn.userId)
    else this.byUser.set(conn.userId, next)
  }

  isOnline(userId: string): boolean {
    return (this.byUser.get(userId)?.length ?? 0) > 0
  }

  connectionsOf(userId: string): LiveConnection[] {
    return [...(this.byUser.get(userId) ?? [])]
  }

  /** Send a frame to every live connection of the user (except one). Returns how many it went to. */
  send(userId: string, frame: Record<string, unknown>, exceptConnectionId?: string): number {
    let sent = 0
    for (const conn of this.connectionsOf(userId)) {
      if (conn.id === exceptConnectionId) continue
      conn.send(frame)
      sent++
    }
    return sent
  }

  get size(): number {
    let n = 0
    for (const list of this.byUser.values()) n += list.length
    return n
  }

  closeAll(code: number, reason: string): void {
    for (const list of this.byUser.values()) for (const c of [...list]) c.close(code, reason)
  }
}
