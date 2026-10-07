import { describe, expect, it } from "vitest";

import { GmailApiError } from "@/lib/gmail/errors";

import { classifyGmailError, GMAIL_ATTACH_BYTES, GMAIL_SEND_SPACING_MS, loadGmailMailbox, type GmailMailboxRow, type GmailSenderDeps } from "./gmail-sender";
import { SendThrottle, type MailboxState, type OutgoingEmail } from "./mailbox-types";
import { MailSendError } from "./send-reason";

function row(over: Partial<GmailMailboxRow> = {}): GmailMailboxRow {
  return { id: "g1", account_id: "A", access_token: "t", access_token_expires_at: "2030-01-01T00:00:00Z", refresh_token: "r", email_address: "support@vircle.com", status: "connected", needs_reauth: false, enabled: true, ...over };
}

/** A clock that only moves when something sleeps, so spacing is visible. */
function world(config: GmailMailboxRow | null, send: (args: Record<string, unknown>) => Promise<unknown> = async () => ({ messageId: "m", threadId: "t" })) {
  let now = 1_000_000;
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
    now += ms;
  };
  const calls: Record<string, unknown>[] = [];
  const reauth: string[] = [];
  const deps: GmailSenderDeps = {
    loadConfig: async () => config,
    getAccessToken: async () => "access",
    sendMail: (async (args: Record<string, unknown>) => {
      calls.push(args);
      return send(args);
    }) as unknown as GmailSenderDeps["sendMail"],
    markNeedsReauth: async (id) => void reauth.push(id),
    throttle: new SendThrottle(GMAIL_SEND_SPACING_MS, () => now, sleep),
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

describe("the Gmail mailbox state", () => {
  it("is none without a connection", async () => {
    expect(await loadGmailMailbox("A", {}, world(null).deps)).toEqual({ kind: "none" });
  });

  it("is a problem to reconnect when Google access was revoked, or the channel says it is not connected", async () => {
    expect(await loadGmailMailbox("A", {}, world(row({ needs_reauth: true })).deps)).toMatchObject({ kind: "problem", provider: "gmail", address: "support@vircle.com", problem: "reconnect" });
    expect(await loadGmailMailbox("A", {}, world(row({ status: "error" })).deps)).toMatchObject({ kind: "problem", problem: "reconnect" });
  });

  it("is paused when the channel is switched off, but a row from before the column existed is not", async () => {
    expect(await loadGmailMailbox("A", {}, world(row({ enabled: false })).deps)).toMatchObject({ kind: "problem", problem: "paused" });
    expect((await loadGmailMailbox("A", {}, world(row({ enabled: undefined })).deps)).kind).toBe("ready");
  });
});

describe("sending through the Gmail mailbox", () => {
  it("sends as the mailbox, under the workspace's name, with Reply-To, the Doc Sign marker and the files", async () => {
    const w = world(row());
    const state = ready(await loadGmailMailbox("A", { headers: { "X-Halo-Sign": "1" } }, w.deps));
    expect(state.attachBytes).toBe(GMAIL_ATTACH_BYTES);
    await state.send(mail({ attachments: [{ filename: "Agreement signed.pdf", content: "AAAA" }] }));
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({
      accessToken: "access",
      toAddress: "ali@example.com",
      subject: "Please sign",
      fromAddress: "support@vircle.com",
      fromName: "Vircle",
      replyTo: "help@vircle.com",
      attachments: [{ name: "Agreement signed.pdf", contentType: "application/pdf", contentBytesBase64: "AAAA" }],
    });
    expect(w.calls[0].headers).toEqual({ "X-Halo-Sign": "1", "Auto-Submitted": "auto-generated" });
  });

  it("drops a Reply-To that is not one plain address", async () => {
    const w = world(row());
    await ready(await loadGmailMailbox("A", {}, w.deps)).send(mail({ replyTo: "a@b.com, c@d.com" }));
    expect(w.calls[0]).not.toHaveProperty("replyTo");
  });

  it("refuses an address that is not an address, without calling Gmail", async () => {
    const w = world(row());
    const e = await failure(ready(await loadGmailMailbox("A", {}, w.deps)).send(mail({ to: "ali@example.com\r\nBcc: x@y.com" })));
    expect(e).toBeInstanceOf(MailSendError);
    expect(e.reason).toBe("address_rejected");
    expect(w.calls).toHaveLength(0);
  });

  it("refuses a message over Gmail's limit before asking", async () => {
    const w = world(row());
    const huge = "A".repeat(26 * 1024 * 1024);
    const e = await failure(ready(await loadGmailMailbox("A", {}, w.deps)).send(mail({ attachments: [{ filename: "a.pdf", content: huge }] })));
    expect(e.reason).toBe("attachment_too_large");
    expect(w.calls).toHaveLength(0);
  });

  it("spaces the sends of one mailbox", async () => {
    const w = world(row());
    const state = ready(await loadGmailMailbox("A", {}, w.deps));
    await state.send(mail());
    await state.send(mail());
    await state.send(mail());
    expect(w.calls).toHaveLength(3);
    expect(w.slept).toEqual([GMAIL_SEND_SPACING_MS, GMAIL_SEND_SPACING_MS]);
  });

  it("marks the mailbox as needing a reconnect when Google says the access is dead, and says so", async () => {
    const w = world(row(), async () => {
      throw new GmailApiError("Invalid Credentials", { httpStatus: 401, status: "UNAUTHENTICATED" });
    });
    const e = await failure(ready(await loadGmailMailbox("A", {}, w.deps)).send(mail()));
    expect(e.reason).toBe("mailbox_reconnect");
    expect(w.reauth).toEqual(["g1"]);
  });

  it("tries once more after a per-second limit, then reports it", async () => {
    let n = 0;
    const w = world(row(), async () => {
      n++;
      if (n === 1) throw new GmailApiError("User-rate limit exceeded", { httpStatus: 429, status: "RESOURCE_EXHAUSTED" });
      return {};
    });
    await ready(await loadGmailMailbox("A", {}, w.deps)).send(mail());
    expect(w.calls).toHaveLength(2);
    expect(w.slept).toContain(2000);

    const always = world(row(), async () => {
      throw new GmailApiError("User-rate limit exceeded", { httpStatus: 429 });
    });
    const e = await failure(ready(await loadGmailMailbox("A", {}, always.deps)).send(mail()));
    expect(e.reason).toBe("rate_limited");
    expect(always.calls).toHaveLength(2);
  });

  it("stops asking Gmail for a while once the day's limit is reached, so a bulk send fails fast and cleanly", async () => {
    const w = world(row(), async () => {
      throw new GmailApiError("Daily user sending quota exceeded.", { httpStatus: 429 });
    });
    const state = ready(await loadGmailMailbox("A", {}, w.deps));
    const first = await failure(state.send(mail()));
    expect(first.reason).toBe("daily_limit");
    expect(first.message).toMatch(/^daily_limit: /);
    for (let i = 0; i < 4; i++) expect((await failure(state.send(mail()))).reason).toBe("daily_limit");
    expect(w.calls).toHaveLength(1);
    // after the cooldown Gmail is asked again
    w.advance(11 * 60_000);
    await failure(state.send(mail()));
    expect(w.calls).toHaveLength(2);
  });

  it("never lets anything but a MailSendError out, even when the token cannot be had", async () => {
    const w = world(row());
    w.deps.getAccessToken = async () => {
      throw new GmailApiError("Token has been expired or revoked.", { httpStatus: 400, status: "invalid_grant" });
    };
    const e = await failure(ready(await loadGmailMailbox("A", {}, w.deps)).send(mail()));
    expect(e).toBeInstanceOf(MailSendError);
    expect(e.reason).toBe("mailbox_reconnect");
  });
});

describe("classifyGmailError", () => {
  const g = (message: string, httpStatus: number, extra: { status?: string; reason?: string } = {}) => classifyGmailError(new GmailApiError(message, { httpStatus, ...extra }));

  it.each([
    ["revoked grant", g("Token revoked", 400, { status: "invalid_grant" }), "mailbox_reconnect"],
    ["missing scope", g("Request had insufficient authentication scopes.", 403, { status: "PERMISSION_DENIED" }), "mailbox_reconnect"],
    ["daily quota", g("Daily user sending quota exceeded.", 429), "daily_limit"],
    ["per-second", g("User-rate limit exceeded. Retry after 2026-10-07T01:02:03Z", 429), "rate_limited"],
    ["reason rateLimitExceeded", g("Rate Limit Exceeded", 403, { reason: "rateLimitExceeded" }), "rate_limited"],
    ["too large", g("Request payload size exceeds the limit", 413), "attachment_too_large"],
    ["bad recipient", g("Invalid To header", 400, { status: "INVALID_ARGUMENT" }), "address_rejected"],
    ["server error", g("Backend Error", 503), "service_unavailable"],
  ])("%s", (_name, e, reason) => {
    expect(e.reason).toBe(reason);
  });

  it("keeps what Gmail said when it is not a case we know", () => {
    const e = g("Mail service not enabled", 400, { status: "FAILED_PRECONDITION" });
    expect(e.reason).toBeNull();
    expect(e.message).toBe("Mail service not enabled");
  });

  it("treats an unreachable network as the service being unavailable", () => {
    expect(classifyGmailError(new TypeError("fetch failed")).reason).toBe("service_unavailable");
  });
});
