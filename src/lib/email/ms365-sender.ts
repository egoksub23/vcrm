/**
 * Sending a workspace's own transactional email (Doc Sign: invitations, codes, signed copies) through the Microsoft 365 mailbox it connected in
 * Settings > Channels > Email, from that mailbox's address, with Microsoft Graph's `sendMail`. The first supported mailbox (see mailbox.ts for the order).
 *
 * `loadMs365Mailbox` says whether the workspace has a Microsoft 365 mailbox that can send; a ready one hands back a `send` that:
 *   - writes the mail as the mailbox (From: the workspace's name and the mailbox's address, Reply-To as the workspace set it); when Exchange refuses
 *     the name on `from` it is sent once more without it, under the mailbox's own name;
 *   - marks it with internet message headers (`X-Halo-Sign: 1`, and `X-Auto-Response-Suppress: All` so out-of-office replies are not sent back) so Halo's
 *     own inbox ingestion never reads it back as a customer's message (lib/ms365/ingest-guard.ts);
 *   - keeps no copy in Sent Items (`saveToSentItems: false`): the mail carries one person's signing link or a signed document, and Doc Sign's own audit
 *     trail records that it was sent, so it is not left lying in a mailbox that other people can open;
 *   - spaces sends out (a mailbox may send about 30 a minute), honours the `Retry-After` of a throttled call once, and stops asking Microsoft for
 *     the time it named when still throttled, so a bulk send does not hammer a mailbox that cannot send;
 *   - never throws anything but a `MailSendError`, whose `reason` names why (revoked consent, a limit, a refused address, a message too big).
 *
 * Files travel inline in the one call, as the inbox composer's attachments do (Graph takes inline file attachments up to about 3 MB). A larger
 * file needs a draft and an upload session, which is not built: above `MS365_ATTACH_BYTES` the message carries a link instead.
 *
 * Every dependency is injectable, so the whole path is tested without Microsoft.
 */

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { GraphApiError } from "@/lib/ms365/errors";
import { sendNewMail } from "@/lib/ms365/mail-api";
import { getValidAccessToken, type EmailConfigRow } from "@/lib/ms365/token";

import { PLAIN_EMAIL, RATE_LIMIT_RETRY_MAX_MS, realSleep, SendThrottle, type MailboxOptions, type MailboxState, type OutgoingEmail } from "./mailbox-types";
import { safeReplyTo } from "./resend";
import { MailSendError } from "./send-reason";

/**
 * The most the files on one message may add up to, as raw bytes, through Microsoft 365. The files go inline in one Graph call (limit about 3 MB for a file,
 * about 4 MB for the call, and base64 makes files a third larger), so 2.5 MB of files is what fits with the text around them. Above this the message
 * carries a link instead.
 */
export const MS365_ATTACH_BYTES = 2.5 * 1024 * 1024;

/** The whole call as sent: the encoded files and the text. */
const MS365_REQUEST_LIMIT = 4 * 1024 * 1024;

/** The shortest gap between two sends from one mailbox: Exchange Online allows about 30 messages a minute. */
export const MS365_SEND_SPACING_MS = 1_000;
/** Waited when Microsoft throttles without saying for how long. */
const DEFAULT_RETRY_AFTER_S = 5;
/** The longest a mailbox is left alone after being throttled. */
const MAX_COOLDOWN_MS = 10 * 60_000;

/** The columns of `email_config` this reads. */
export type Ms365MailboxRow = EmailConfigRow & {
  mailbox_address: string;
  status?: string | null;
  needs_reauth?: boolean | null;
  enabled?: boolean | null;
};

export interface Ms365SenderDeps {
  loadConfig: (accountId: string) => Promise<Ms365MailboxRow | null>;
  getAccessToken: (config: Ms365MailboxRow) => Promise<string>;
  sendMail: typeof sendNewMail;
  markNeedsReauth: (configId: string) => Promise<void>;
  throttle: SendThrottle;
  sleep: (ms: number) => Promise<void>;
}

export const realMs365Deps: Ms365SenderDeps = {
  loadConfig: async (accountId) => {
    const { data, error } = await supabaseAdmin().from("email_config").select("*").eq("account_id", accountId).maybeSingle();
    if (error) throw error;
    return (data as Ms365MailboxRow | null) ?? null;
  },
  getAccessToken: (config) => getValidAccessToken(config),
  sendMail: sendNewMail,
  markNeedsReauth: async (configId) => {
    await supabaseAdmin().from("email_config").update({ needs_reauth: true }).eq("id", configId);
  },
  throttle: new SendThrottle(MS365_SEND_SPACING_MS, Date.now, realSleep),
  sleep: realSleep,
};

// ---- why a send failed -------------------------------------------------------------------------------

const AUTH_CODES = new Set(["InvalidAuthenticationToken", "invalid_grant", "interaction_required", "consent_required", "invalid_client", "unauthorized_client"]);
const THROTTLE_CODES = new Set(["TooManyRequests", "ApplicationThrottled", "MailboxConcurrency", "ActivityLimitReached", "ErrorTooManyRequests"]);
const LIMIT_CODES = new Set(["ErrorExceededMessageLimit", "ErrorQuotaExceeded", "ErrorSendQuotaExceeded", "RecipientRateLimitExceeded", "ErrorExceededMaxRecipients"]);
const SIZE_CODES = new Set(["ErrorMessageSizeExceeded", "ErrorItemSizeExceeded", "ErrorAttachmentSizeLimitExceeded", "ErrorMessageTooBig"]);
const RECIPIENT_CODES = new Set(["ErrorInvalidRecipients", "ErrorRecipientNotFound", "ErrorInvalidSmtpAddress", "ErrorNonExistentMailbox", "ErrorInvalidUser"]);
const SERVICE_CODES = new Set(["ErrorServerBusy", "ServiceNotAvailable", "ErrorTimeoutExpired", "ErrorInternalServerError", "ErrorInternalServerTransientError"]);

/**
 * Turn whatever a Graph call threw into the one error this module lets out. Pure.
 *   - a dead or revoked grant, consent withdrawn, access denied                -> mailbox_reconnect
 *   - the sending limit (per day)                                              -> daily_limit
 *   - throttling (429, MailboxConcurrency, ApplicationThrottled, a per-minute limit) -> rate_limited
 *   - a recipient Exchange will not accept                                     -> address_rejected
 *   - a message over the size limit                                            -> attachment_too_large
 *   - a 5xx, server busy or a network failure                                  -> service_unavailable
 * Anything else keeps what Microsoft said, with no reason word.
 */
export function classifyGraphError(err: unknown): MailSendError {
  if (err instanceof MailSendError) return err;
  if (err instanceof GraphApiError) {
    const said = err.message;
    const code = err.code ?? "";
    if (err.isAuthError || AUTH_CODES.has(code)) return new MailSendError("mailbox_reconnect", said);
    if (err.httpStatus === 403 && (code === "ErrorAccessDenied" || code === "Authorization_RequestDenied" || /access is denied|insufficient privileges/i.test(said))) {
      return new MailSendError("mailbox_reconnect", said);
    }
    if (LIMIT_CODES.has(code) || /exceeded.*(limit|quota)|recipient rate limit/i.test(said)) {
      return new MailSendError(/\bday\b|daily|24 hours/i.test(said) ? "daily_limit" : "rate_limited", said);
    }
    if (err.httpStatus === 429 || THROTTLE_CODES.has(code) || /throttl|too many requests/i.test(said)) return new MailSendError("rate_limited", said);
    if (err.httpStatus === 413 || SIZE_CODES.has(code) || /too large|size (limit )?exceed|exceeds the (maximum )?size/i.test(said)) return new MailSendError("attachment_too_large", said);
    if (RECIPIENT_CODES.has(code) || /recipient/i.test(code) || (err.httpStatus === 400 && /recipient|invalid.*address/i.test(said))) return new MailSendError("address_rejected", said);
    if (err.httpStatus >= 500 || SERVICE_CODES.has(code)) return new MailSendError("service_unavailable", said);
    return new MailSendError(null, said);
  }
  const said = err instanceof Error ? err.message : "send failed";
  // fetch() rejects with a TypeError when Microsoft cannot be reached at all
  if (err instanceof TypeError || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(said)) return new MailSendError("service_unavailable", said);
  return new MailSendError(null, said);
}

/** Whether Exchange refused the `from` name or address (so the mail is worth sending once more without it). */
function refusedFrom(err: unknown): boolean {
  if (!(err instanceof GraphApiError) || err.httpStatus < 400 || err.httpStatus >= 500 || err.httpStatus === 401 || err.httpStatus === 429) return false;
  return /send ?as|sender|impersonat|\bfrom\b/i.test(`${err.code ?? ""} ${err.message}`);
}

/** The call's own size, estimated before Microsoft is asked: files as base64 plus the text. */
function estimatedBytes(m: OutgoingEmail): number {
  const files = (m.attachments ?? []).reduce((sum, a) => sum + a.content.length + 300, 0);
  return files + Buffer.byteLength(m.html) + Buffer.byteLength(m.text) + 2_000;
}

const contentTypeOf = (filename: string) => (/\.pdf$/i.test(filename) ? "application/pdf" : "application/octet-stream");

// ---- the mailbox ------------------------------------------------------------------------------------

/**
 * The workspace's connected Microsoft 365 mailbox, or why there is none that can send. Throws only when the connection itself cannot be read
 * (the caller treats that as `unavailable`).
 */
export async function loadMs365Mailbox(accountId: string, opts: MailboxOptions = {}, deps: Ms365SenderDeps = realMs365Deps): Promise<MailboxState> {
  const config = await deps.loadConfig(accountId);
  if (!config) return { kind: "none" };
  const address = String(config.mailbox_address ?? "").trim();
  if (!address) return { kind: "none" };
  if (config.status && config.status !== "connected") return { kind: "problem", provider: "microsoft365", address, problem: "reconnect" };
  if (config.needs_reauth === true) return { kind: "problem", provider: "microsoft365", address, problem: "reconnect" };
  // === false, not falsy: a row read before the column existed is not paused
  if (config.enabled === false) return { kind: "problem", provider: "microsoft365", address, problem: "paused" };

  const key = `microsoft365:${accountId}`;
  // Graph accepts only `X-...` internet message headers
  const headers = { ...opts.headers, "X-Auto-Response-Suppress": "All" };
  return {
    kind: "ready",
    provider: "microsoft365",
    address,
    attachBytes: MS365_ATTACH_BYTES,
    send: async (m) => {
      deps.throttle.assertOpen(key);
      if (!PLAIN_EMAIL.test(m.to.trim())) throw new MailSendError("address_rejected", "the address is not a valid email address");
      if (estimatedBytes(m) > MS365_REQUEST_LIMIT) throw new MailSendError("attachment_too_large", "the message with its files is too large to send through Microsoft 365");

      let accessToken: string;
      try {
        accessToken = await deps.getAccessToken(config);
      } catch (err) {
        throw classifyGraphError(err);
      }

      const files = (m.attachments ?? []).map((a) => ({ name: a.filename, contentType: contentTypeOf(a.filename), contentBytesBase64: a.content }));
      const replyTo = safeReplyTo(m.replyTo);
      let withFrom = true;
      let throttled = false;
      for (;;) {
        await deps.throttle.pace(key);
        try {
          await deps.sendMail({
            accessToken,
            toAddress: m.to.trim(),
            subject: m.subject,
            text: m.text,
            html: m.html,
            ...(files.length ? { attachments: files } : {}),
            ...(withFrom ? { fromAddress: address, ...(m.fromName ? { fromName: m.fromName } : {}) } : {}),
            ...(replyTo ? { replyTo } : {}),
            headers,
            saveToSentItems: false,
          });
          return;
        } catch (err) {
          // Exchange does not let this mailbox write that name or address on `from`: send once more under the mailbox's own name
          if (withFrom && refusedFrom(err)) {
            withFrom = false;
            continue;
          }
          const failure = classifyGraphError(err);
          if (failure.reason === "mailbox_reconnect") await deps.markNeedsReauth(config.id).catch(() => undefined);
          if (failure.reason === "daily_limit") deps.throttle.block(key, "daily_limit", MAX_COOLDOWN_MS);
          if (failure.reason === "rate_limited") {
            const waitMs = (err instanceof GraphApiError && err.retryAfterSeconds ? err.retryAfterSeconds : DEFAULT_RETRY_AFTER_S) * 1000;
            // wait as asked and try once more when it is short; otherwise leave the mailbox alone for as long as Microsoft said
            if (!throttled && waitMs <= RATE_LIMIT_RETRY_MAX_MS) {
              throttled = true;
              await deps.sleep(waitMs);
              continue;
            }
            deps.throttle.block(key, "rate_limited", Math.min(waitMs, MAX_COOLDOWN_MS));
          }
          throw failure;
        }
      }
    },
  };
}
