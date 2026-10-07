/**
 * What every connected-mailbox sender (Microsoft 365, Gmail) has in common: the message it is given, the state it reports, and the pacing that keeps a
 * mailbox inside its provider's sending limits. No provider code here.
 */

import { MailSendError, type SendReason } from "./send-reason";
import type { EmailAttachment, EmailIdentity } from "./resend";

/** What one message needs: the same shape the Resend sender takes. */
export interface OutgoingEmail extends EmailIdentity {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

/** Which connected mailbox a message goes through. */
export type MailboxProvider = "microsoft365" | "gmail";

export type MailboxProblem = "reconnect" | "paused" | "unavailable";

export type MailboxState =
  | { kind: "none" }
  /** A mailbox is connected but cannot send now. */
  | { kind: "problem"; provider: MailboxProvider; address: string; problem: MailboxProblem }
  /** `attachBytes`: the most the files on one message may add up to, as raw bytes, through this mailbox. */
  | { kind: "ready"; provider: MailboxProvider; address: string; attachBytes: number; send: (m: OutgoingEmail) => Promise<void> };

/** What the sender adds to every message. Doc Sign passes its marker header here. */
export interface MailboxOptions {
  headers?: Record<string, string>;
}

export const PLAIN_EMAIL = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;

/**
 * Spacing between sends from one mailbox, and a stop after a limit is reached, per workspace. Held in memory: a courtesy to the provider so a bulk
 * send does not hammer a mailbox that cannot send, not a record of anything.
 */
export class SendThrottle {
  private readonly last = new Map<string, number>();
  private readonly blocked = new Map<string, { until: number; reason: SendReason }>();

  /** `spacingMs`: the shortest gap between two sends from one mailbox. */
  constructor(
    private readonly spacingMs: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  /** Throws the limit's failure while the mailbox is in its cooldown. */
  assertOpen(key: string): void {
    const b = this.blocked.get(key);
    if (!b) return;
    if (this.now() < b.until) throw new MailSendError(b.reason, "the mailbox hit its sending limit a moment ago");
    this.blocked.delete(key);
  }

  block(key: string, reason: SendReason, ms: number): void {
    this.blocked.set(key, { until: this.now() + ms, reason });
  }

  /** Wait for this send's slot: each send from one mailbox starts at least `spacingMs` after the one before. */
  async pace(key: string): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, (this.last.get(key) ?? 0) + this.spacingMs);
    this.last.set(key, slot);
    if (slot > now) await this.sleep(slot - now);
  }
}

export const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Failures that are the provider saying "slow down", for the one retry and the cooldown. */
export const RATE_LIMIT_RETRY_MAX_MS = 15_000;
