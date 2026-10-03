// ============================================================
// The one place the gateway meets the Vircle push API.
//
// The owner's decision (3 Oct 2026): Vircle already runs push (FCM, APNs, Huawei) behind an API that is
// given a phone number or an email, finds the user and sends the alert. The gateway decides WHEN to
// push and calls that API; it holds no push credentials and talks to no push service itself.
//
// Two implementations behind this interface: the mock (src/push/mock.ts: records every push, used by the
// tests and the simulator) and, once the API's details are known, the real one (work package 8, one file).
// ============================================================

export interface PushRequest {
  /** At least one of phone and email is set; the API finds the user from either. */
  phone: string | null
  email: string | null
  /** The user's wallet id, for adapters whose API can use it. */
  walletId: string
  title: string
  body: string
  /** Where tapping the alert goes: this user's conversation. */
  deepLink: string
  /** Alerts with the same key replace one another on the phone (the conversation id). */
  collapseKey: string
}

export type PushResult =
  /** The API accepted the alert. */
  | { status: 'sent' }
  /** The API does not know the user, or the user has no app installed or registered. Nothing to retry. */
  | { status: 'no_device' }
  /** The call failed. `retryable`: a later attempt may work (no answer, 5xx, 429). */
  | { status: 'failed'; error: string; retryable: boolean }

export interface PushAdapter {
  readonly name: string
  send(request: PushRequest): Promise<PushResult>
}
