import { describe, expect, it } from "vitest";

import { GraphApiError } from "@/lib/ms365/errors";

import { SendThrottle, type MailboxState, type OutgoingEmail } from "./mailbox-types";
import { classifyGraphError, loadMs365Mailbox, MS365_ATTACH_BYTES, MS365_SEND_SPACING_MS, type Ms365MailboxRow, type Ms365SenderDeps } from "./ms365-sender";
import { MailSendError } from "./send-reason";

function row(over: Partial<Ms365MailboxRow> = {}): Ms365MailboxRow {
  return { id: "e1", account_id: "A", access_token: "t", access_token_expires_at: "2030-01-01T00:00:00Z", refresh_token: "r", mailbox_address: "support@vircle.com", status: "connected", needs_reauth: false, enabled: true, ...over };
}

function world(config: Ms365MailboxRow | null, send: (args: Record<string, unknown>) => Promise<unknown> = async () => undefined) {
  let now = 5_000_000;
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
    now += ms;
  };
  const calls: Record<string, unknown>[] = [];
  const reauth: string[] = [];
  const deps: Ms365SenderDeps = {
    loadConfig: async () => config,
    getAccessToken: async () => "access",
    sendMail: (async (args: Record<string, unknown>) => {
      calls.push(args);
      return send(args);
    }) as unknown as Ms365SenderDeps["sendMail"],
    markNeedsReauth: async (id) => void reauth.push(id),
    throttle: new SendThrottle(MS365_SEND_SPACING_MS, () => now, sleep),
    sleep,
  };
  return { deps, calls, slept, reauth, advance: (ms: number) => void (now += ms) };
}

const mail = (over: Partial<OutgoingEmail> = {}): OutgoingEmail => ({ to: "ali@example.com", subject: "Please sign", html: "<p>hi</p>", text: "hi", fromName: "Vircle", replyTo: "help@vircle.com", ...over });
const ready = (s: MailboxState) => {
  if (s.kind !== "ready") throw new Error(`not ready: ${s.kind}`);
  return s;
};
const failure = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as MailSendError;
const graph = (message: string, httpStatus: number, code: string | null = null, retryAfterSeconds: number | null = null) => new GraphApiError(message, { httpStatus, code, retryAfterSeconds });

describe("the Microsoft 365 mailbox state", () => {
  it("is none without a connection", async () => {
    expect(await loadMs365Mailbox("A", {}, world(null).deps)).toEqual({ kind: "none" });
  });

  it("is a problem to reconnect when consent was revoked, or the channel says it is not connected", async () => {
    expect(await loadMs365Mailbox("A", {}, world(row({ needs_reauth: true })).deps)).toMatchObject({ kind: "problem", provider: "microsoft365", address: "support@vircle.com", problem: "reconnect" });
    expect(await loadMs365Mailbox("A", {}, world(row({ status: "disconnected" })).deps)).toMatchObject({ kind: "problem", problem: "reconnect" });
  });

  it("is paused when the channel is switched off, but a row from before the column existed is not", async () => {
    expect(await loadMs365Mailbox("A", {}, world(row({ enabled: false })).deps)).toMatchObject({ kind: "problem", problem: "paused" });
    expect((await loadMs365Mailbox("A", {}, world(row({ enabled: undefined })).deps)).kind).toBe("ready");
  });
});

describe("sending through the Microsoft 365 mailbox", () => {
  it("sends as the mailbox with the Secure Sign marker, keeps no copy in Sent Items, and takes only X- headers", async () => {
    const w = world(row());
    const state = ready(await loadMs365Mailbox("A", { headers: { "X-Halo-Sign": "1" } }, w.deps));
    expect(state.attachBytes).toBe(MS365_ATTACH_BYTES);
    await state.send(mail({ attachments: [{ filename: "Agreement signed.pdf", content: "AAAA" }] }));
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({
      accessToken: "access",
      toAddress: "ali@example.com",
      subject: "Please sign",
      fromAddress: "support@vircle.com",
      fromName: "Vircle",
      replyTo: "help@vircle.com",
      saveToSentItems: false,
      attachments: [{ name: "Agreement signed.pdf", contentType: "application/pdf", contentBytesBase64: "AAAA" }],
    });
    const headers = w.calls[0].headers as Record<string, string>;
    expect(headers).toEqual({ "X-Halo-Sign": "1", "X-Auto-Response-Suppress": "All" });
    for (const name of Object.keys(headers)) expect(name).toMatch(/^X-/);
  });

  it("refuses an address that is not an address, without calling Microsoft", async () => {
    const w = world(row());
    const e = await failure(ready(await loadMs365Mailbox("A", {}, w.deps)).send(mail({ to: "not an address" })));
    expect(e.reason).toBe("address_rejected");
    expect(w.calls).toHaveLength(0);
  });

  it("refuses a call over the inline limit before asking", async () => {
    const w = world(row());
    const e = await failure(ready(await loadMs365Mailbox("A", {}, w.deps)).send(mail({ attachments: [{ filename: "a.pdf", content: "A".repeat(5 * 1024 * 1024) }] })));
    expect(e.reason).toBe("attachment_too_large");
    expect(w.calls).toHaveLength(0);
  });

  it("spaces the sends of one mailbox (about 30 a minute is the most Exchange Online allows)", async () => {
    const w = world(row());
    const state = ready(await loadMs365Mailbox("A", {}, w.deps));
    await state.send(mail());
    await state.send(mail());
    expect(w.slept).toEqual([MS365_SEND_SPACING_MS]);
  });

  it("sends once more under the mailbox's own name when Exchange refuses the name on `from`", async () => {
    let n = 0;
    const w = world(row(), async () => {
      n++;
      if (n === 1) throw graph("The user is not allowed to send as this sender.", 403, "ErrorSendAsDenied");
    });
    await ready(await loadMs365Mailbox("A", {}, w.deps)).send(mail());
    expect(w.calls).toHaveLength(2);
    expect(w.calls[0]).toHaveProperty("fromAddress");
    expect(w.calls[1]).not.toHaveProperty("fromAddress");
    expect(w.calls[1]).not.toHaveProperty("fromName");
  });

  it("marks the mailbox as needing a reconnect when the token is dead, and says so", async () => {
    const w = world(row(), async () => {
      throw graph("Access token has expired or is not yet valid.", 401, "InvalidAuthenticationToken");
    });
    const e = await failure(ready(await loadMs365Mailbox("A", {}, w.deps)).send(mail()));
    expect(e.reason).toBe("mailbox_reconnect");
    expect(w.reauth).toEqual(["e1"]);
  });

  it("waits as long as Retry-After says (when short), tries once more, then reports the throttle", async () => {
    let n = 0;
    const w = world(row(), async () => {
      n++;
      if (n === 1) throw graph("Application is over its MailboxConcurrency limit.", 429, "MailboxConcurrency", 7);
    });
    await ready(await loadMs365Mailbox("A", {}, w.deps)).send(mail());
    expect(w.calls).toHaveLength(2);
    expect(w.slept).toContain(7000);

    const always = world(row(), async () => {
      throw graph("Too many requests", 429, "TooManyRequests", 3);
    });
    const e = await failure(ready(await loadMs365Mailbox("A", {}, always.deps)).send(mail()));
    expect(e.reason).toBe("rate_limited");
    expect(always.calls).toHaveLength(2);
  });

  it("does not wait for a long Retry-After: it fails at once and leaves the mailbox alone for as long as Microsoft said, so a bulk send fails fast", async () => {
    const w = world(row(), async () => {
      throw graph("Too many requests", 429, "TooManyRequests", 120);
    });
    const state = ready(await loadMs365Mailbox("A", {}, w.deps));
    const first = await failure(state.send(mail()));
    expect(first.reason).toBe("rate_limited");
    expect(w.calls).toHaveLength(1);
    for (let i = 0; i < 3; i++) expect((await failure(state.send(mail()))).reason).toBe("rate_limited");
    expect(w.calls).toHaveLength(1);
    w.advance(121_000);
    await failure(state.send(mail()));
    expect(w.calls).toHaveLength(2);
  });

  it("stops asking once the daily limit is reached", async () => {
    const w = world(row(), async () => {
      throw graph("You have exceeded your daily limit for sending messages.", 400, "ErrorExceededMessageLimit");
    });
    const state = ready(await loadMs365Mailbox("A", {}, w.deps));
    expect((await failure(state.send(mail()))).reason).toBe("daily_limit");
    expect((await failure(state.send(mail()))).reason).toBe("daily_limit");
    expect(w.calls).toHaveLength(1);
  });

  it("never lets anything but a MailSendError out, even when the token cannot be had", async () => {
    const w = world(row());
    w.deps.getAccessToken = async () => {
      throw graph("The refresh token has expired.", 400, "invalid_grant");
    };
    const e = await failure(ready(await loadMs365Mailbox("A", {}, w.deps)).send(mail()));
    expect(e).toBeInstanceOf(MailSendError);
    expect(e.reason).toBe("mailbox_reconnect");
  });
});

describe("classifyGraphError", () => {
  it.each([
    ["dead token", graph("expired", 401, "InvalidAuthenticationToken"), "mailbox_reconnect"],
    ["revoked grant", graph("AADSTS70008", 400, "invalid_grant"), "mailbox_reconnect"],
    ["consent needed again", graph("needs consent", 400, "interaction_required"), "mailbox_reconnect"],
    ["access denied", graph("Access is denied. Check credentials and try again.", 403, "ErrorAccessDenied"), "mailbox_reconnect"],
    ["429", graph("Too many requests", 429, "TooManyRequests"), "rate_limited"],
    ["ApplicationThrottled", graph("Application throttled", 503, "ApplicationThrottled"), "rate_limited"],
    ["MailboxConcurrency", graph("Concurrent connections", 429, "MailboxConcurrency"), "rate_limited"],
    ["per-minute limit", graph("Message rate limit per minute exceeded", 400, "ErrorExceededMessageLimit"), "rate_limited"],
    ["per-day limit", graph("Recipient rate limit exceeded: 10000 per day", 400, "ErrorQuotaExceeded"), "daily_limit"],
    ["too large", graph("The message exceeds the maximum size", 400, "ErrorMessageSizeExceeded"), "attachment_too_large"],
    ["413", graph("Request Entity Too Large", 413), "attachment_too_large"],
    ["bad recipient", graph("One or more recipients are invalid", 400, "ErrorInvalidRecipients"), "address_rejected"],
    ["server busy", graph("Server busy", 503, "ErrorServerBusy"), "service_unavailable"],
    ["500", graph("Internal error", 500), "service_unavailable"],
  ])("%s", (_name, e, reason) => {
    expect(classifyGraphError(e).reason).toBe(reason);
  });

  it("keeps what Microsoft said when it is not a case we know (a mailbox with no Exchange Online licence, for one)", () => {
    const e = classifyGraphError(graph("The mailbox is either inactive, soft-deleted, or is hosted on-premise.", 404, "MailboxNotEnabledForRESTAPI"));
    expect(e.reason).toBeNull();
    expect(e.message).toMatch(/mailbox is either inactive/);
  });

  it("treats an unreachable network as the service being unavailable", () => {
    expect(classifyGraphError(new TypeError("fetch failed")).reason).toBe("service_unavailable");
  });
});
