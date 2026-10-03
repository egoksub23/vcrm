// ============================================================
// The mock push adapter: records every alert the gateway would have sent, and can be told how to answer.
// Used by the tests, and by the simulator's "push inbox" (work package 6). Nothing leaves the process.
// ============================================================

import type { PushAdapter, PushRequest, PushResult } from './adapter'

export interface RecordedPush extends PushRequest {
  at: Date
  result: PushResult
}

export class MockPushAdapter implements PushAdapter {
  readonly name = 'mock'
  /** Every alert, oldest first, with what the mock answered. */
  readonly sent: RecordedPush[] = []

  private script: PushResult[] = []
  private decide: ((request: PushRequest) => PushResult | null) | null = null

  /** Answer the next calls with these results, in order; after them the default (`sent`) applies again. */
  answerNext(...results: PushResult[]): this {
    this.script.push(...results)
    return this
  }

  /** Decide per request (return null for the default). For "this user has no app", "this phone number is unknown". */
  answerWith(fn: ((request: PushRequest) => PushResult | null) | null): this {
    this.decide = fn
    return this
  }

  /** The user with this phone or email has no app registered. */
  noDeviceFor(phoneOrEmail: string): this {
    return this.answerWith((r) => (r.phone === phoneOrEmail || r.email === phoneOrEmail ? { status: 'no_device' } : null))
  }

  reset(): void {
    this.sent.length = 0
    this.script = []
    this.decide = null
  }

  async send(request: PushRequest): Promise<PushResult> {
    const result = this.script.shift() ?? this.decide?.(request) ?? ({ status: 'sent' } as const)
    this.sent.push({ ...request, at: new Date(), result })
    return result
  }
}
