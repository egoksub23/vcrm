/**
 * Sending a workspace's own transactional email (Secure Sign: invitations, codes, signed copies; team invitations; notifications) through the Gmail
 * mailbox it connected in Settings > Channels > Gmail, from that mailbox's address. The second supported mailbox (see mailbox.ts for the order);
 * Microsoft 365 is first.
 *
 * `loadGmailMailbox` says whether the workspace has a Gmail mailbox that can send. That depends on the connection (connected, not needing a new
 * sign-in) and the master pause (`enabled`); it does NOT depend on `inbox_enabled`, the switch for using the mailbox as the customer care inbox.
 * A ready one hands back a `send` that:
 *   - writes the mail as the mailbox (From: the workspace's name and the mailbox's address, Reply-To as the workspace set it);
 *   - marks it with headers (`X-Halo-System: 1` on everything, whoever sends it; the caller's own marks such as Secure Sign's `X-Halo-Sign: 1`;
 *     `Auto-Submitted`) so Halo's own inbox ingestion never reads it back as a customer's message (lib/gmail/ingest-guard.ts);
 *   - spaces sends out (Gmail allows only a few a second), tries once more on a per-second limit, and stops asking Gmail for a while once the
 *     day's sending limit is reached, so a bulk send does not hammer a mailbox that cannot send;
 *   - never throws anything but a `MailSendError`, whose `reason` names why (revoked access, a limit, a refused address, a message too big).
 *
 * Every dependency is injectable, so the whole path is tested without Gmail.
 */

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { GmailApiError } from "@/lib/gmail/errors";
import { sendNewMail } from "@/lib/gmail/gmail-api";
import { getValidAccessToken, type GmailConfigRow } from "@/lib/gmail/token";

import { HALO_SYSTEM_HEADERS } from "./halo-mail-marker";
import { mailboxSendProblem, PLAIN_EMAIL, realSleep, SendThrottle, type MailboxOptions, type MailboxState, type OutgoingEmail } from "./mailbox-types";
import { safeReplyTo } from "./resend";
import { MailSendError } from "./send-reason";

/**
 * The most the files on one message may add up to, as raw bytes, through Gmail. Gmail refuses a message over 25 MB, and base64 makes files about a
 * third larger, so about 17 MB of files is what fits with the text and headers around them. Above this the message carries a link instead.
 */
export const GMAIL_ATTACH_BYTES = 17 * 1024 * 1024;

/** Gmail's limit for the whole message as sent (headers, text and the encoded files). */
const GMAIL_MESSAGE_LIMIT = 25 * 1024 * 1024;

/** The shortest gap between two sends from one mailbox. Gmail allows about two a second; this stays well under it. */
export const GMAIL_SEND_SPACING_MS = 400;
/** How long to wait before the one retry after Gmail says "too fast". */
const RATE_LIMIT_PAUSE_MS = 2_000;
/** After the day's limit is reached, Gmail is not asked again for this long. */
export const DAILY_LIMIT_COOLDOWN_MS = 10 * 60_000;

/** The columns of `gmail_config` this reads. */
export type GmailMailboxRow = GmailConfigRow & {
  email_address: string;
  status?: string | null;
  needs_reauth?: boolean | null;
  /** The master pause: false = nothing in, nothing out. */
  enabled?: boolean | null;
  /** Use this mailbox for the customer care inbox. Not read here: it does not decide whether Halo can send through the mailbox. */
  inbox_enabled?: boolean | null;
};

export interface GmailSenderDeps {
  loadConfig: (accountId: string) => Promise<GmailMailboxRow | null>;
  getAccessToken: (config: GmailMailboxRow) => Promise<string>;
  sendMail: typeof sendNewMail;
  markNeedsReauth: (configId: string) => Promise<void>;
  throttle: SendThrottle;
  sleep: (ms: number) => Promise<void>;
}

export const realGmailDeps: GmailSenderDeps = {
  loadConfig: async (accountId) => {
    const { data, error } = await supabaseAdmin().from("gmail_config").select("*").eq("account_id", accountId).maybeSingle();
    if (error) throw error;
    return (data as GmailMailboxRow | null) ?? null;
  },
  getAccessToken: (config) => getValidAccessToken(config),
  sendMail: sendNewMail,
  markNeedsReauth: async (configId) => {
    await supabaseAdmin().from("gmail_config").update({ needs_reauth: true }).eq("id", configId);
  },
  throttle: new SendThrottle(GMAIL_SEND_SPACING_MS, Date.now, realSleep),
  sleep: realSleep,
};

// ---- why a send failed -------------------------------------------------------------------------------

/**
 * Turn whatever a Gmail call threw into the one error this module lets out. Pure.
 *   - a dead or revoked grant (401, `invalid_grant`, missing scope)           -> mailbox_reconnect
 *   - the day's sending quota                                                  -> daily_limit
 *   - too many requests a second (429, rateLimitExceeded)                      -> rate_limited
 *   - a recipient Gmail will not accept                                        -> address_rejected
 *   - a message over the size limit (413, "too large")                         -> attachment_too_large
 *   - a 5xx or a network failure                                               -> service_unavailable
 * Anything else keeps what Gmail said, with no reason word.
 */
export function classifyGmailError(err: unknown): MailSendError {
  if (err instanceof MailSendError) return err;
  if (err instanceof GmailApiError) {
    const said = err.message;
    const code = err.reason ?? "";
    if (err.isAuthError) return new MailSendError("mailbox_reconnect", said);
    if (err.httpStatus === 403 && (code === "insufficientPermissions" || /insufficient (authentication )?scopes?|insufficient permission/i.test(said))) {
      return new MailSendError("mailbox_reconnect", said);
    }
    if (/daily|quota|sending limit/i.test(said) || code === "dailyLimitExceeded") return new MailSendError("daily_limit", said);
    if (err.httpStatus === 429 || err.status === "RESOURCE_EXHAUSTED" || code === "rateLimitExceeded" || code === "userRateLimitExceeded" || /rate limit/i.test(said)) {
      return new MailSendError("rate_limited", said);
    }
    if (err.httpStatus === 413 || /too large|exceeds the (maximum )?(size|limit)|message size/i.test(said)) return new MailSendError("attachment_too_large", said);
    if (err.httpStatus === 400 && /recipient|invalid to|"to" header|address/i.test(said)) return new MailSendError("address_rejected", said);
    if (err.httpStatus >= 500) return new MailSendError("service_unavailable", said);
    return new MailSendError(null, said);
  }
  const said = err instanceof Error ? err.message : "send failed";
  // fetch() rejects with a TypeError when Google cannot be reached at all
  if (err instanceof TypeError || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(said)) return new MailSendError("service_unavailable", said);
  return new MailSendError(null, said);
}

/** The message's own size, estimated before Gmail is asked: files as base64 plus the text twice over (plain and HTML). */
function estimatedBytes(m: OutgoingEmail): number {
  const files = (m.attachments ?? []).reduce((sum, a) => sum + a.content.length + 400, 0);
  return files + Buffer.byteLength(m.html) + Buffer.byteLength(m.text) + 2_000;
}

const contentTypeOf = (filename: string) => (/\.pdf$/i.test(filename) ? "application/pdf" : "application/octet-stream");

// ---- the mailbox ------------------------------------------------------------------------------------

/**
 * The workspace's connected Gmail mailbox, or why there is none that can send. Throws only when the connection itself cannot be read
 * (the caller treats that as `unavailable`).
 */
export async function loadGmailMailbox(accountId: string, opts: MailboxOptions = {}, deps: GmailSenderDeps = realGmailDeps): Promise<MailboxState> {
  const config = await deps.loadConfig(accountId);
  if (!config) return { kind: "none" };
  const address = String(config.email_address ?? "").trim();
  if (!address) return { kind: "none" };
  // a status written by the channel itself: only "connected" can send
  const problem = mailboxSendProblem(config);
  if (problem) return { kind: "problem", provider: "gmail", address, problem };

  const key = `gmail:${accountId}`;
  const headers = { ...opts.headers, ...HALO_SYSTEM_HEADERS, "Auto-Submitted": "auto-generated" };
  return {
    kind: "ready",
    provider: "gmail",
    address,
    attachBytes: GMAIL_ATTACH_BYTES,
    send: async (m) => {
      deps.throttle.assertOpen(key);
      if (!PLAIN_EMAIL.test(m.to.trim())) throw new MailSendError("address_rejected", "the address is not a valid email address");
      if (estimatedBytes(m) > GMAIL_MESSAGE_LIMIT) throw new MailSendError("attachment_too_large", "the message with its files is over Gmail's 25 MB limit");

      let accessToken: string;
      try {
        accessToken = await deps.getAccessToken(config);
      } catch (err) {
        throw classifyGmailError(err);
      }

      const files = (m.attachments ?? []).map((a) => ({ name: a.filename, contentType: contentTypeOf(a.filename), contentBytesBase64: a.content }));
      const replyTo = safeReplyTo(m.replyTo);
      for (let attempt = 0; ; attempt++) {
        await deps.throttle.pace(key);
        try {
          await deps.sendMail({
            accessToken,
            toAddress: m.to.trim(),
            subject: m.subject,
            text: m.text,
            html: m.html,
            ...(files.length ? { attachments: files } : {}),
            fromAddress: address,
            ...(m.fromName ? { fromName: m.fromName } : {}),
            ...(replyTo ? { replyTo } : {}),
            headers,
          });
          return;
        } catch (err) {
          const failure = classifyGmailError(err);
          if (failure.reason === "mailbox_reconnect") await deps.markNeedsReauth(config.id).catch(() => undefined);
          if (failure.reason === "daily_limit") deps.throttle.block(key, "daily_limit", DAILY_LIMIT_COOLDOWN_MS);
          // one more try after a pause when Gmail only said "too fast"
          if (failure.reason === "rate_limited" && attempt === 0) {
            await deps.sleep(RATE_LIMIT_PAUSE_MS);
            continue;
          }
          throw failure;
        }
      }
    },
  };
}
