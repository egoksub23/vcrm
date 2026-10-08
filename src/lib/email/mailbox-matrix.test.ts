import { describe, expect, it } from "vitest";

import type { GmailMailboxRow, GmailSenderDeps } from "./gmail-sender";
import { loadGmailMailbox } from "./gmail-sender";
import { loadMailboxState, type MailboxDeps } from "./mailbox";
import { mailboxSendProblem } from "./mailbox-types";
import type { Ms365MailboxRow, Ms365SenderDeps } from "./ms365-sender";
import { loadMs365Mailbox } from "./ms365-sender";

// The two switches of a connected mailbox are independent:
//   enabled        the master pause. false = nothing in, nothing out.
//   inbox_enabled  use the mailbox for the customer care inbox. It decides what comes IN to the Inbox and what the Inbox offers; it never decides
//                  whether Halo can send its own email through the mailbox.
// Whether Halo may send as the workspace is therefore: connected, not needing a new sign-in, and enabled. These tests walk every combination of
// (connected state) x enabled x inbox_enabled x needs_reauth for both providers and for the chooser that puts them in order.

type Connected = "absent" | "connected" | "disconnected" | "error";
const CONNECTED: Connected[] = ["absent", "connected", "disconnected", "error"];
const BOOL = [true, false] as const;

const ms = (row: Ms365MailboxRow | null) => ({ loadConfig: async () => row }) as unknown as Ms365SenderDeps;
const gm = (row: GmailMailboxRow | null) => ({ loadConfig: async () => row }) as unknown as GmailSenderDeps;

function msRow(connected: Connected, enabled: boolean, inbox: boolean, reauth: boolean): Ms365MailboxRow | null {
  if (connected === "absent") return null;
  return { id: "e", account_id: "A", access_token: "t", access_token_expires_at: "2030-01-01T00:00:00Z", refresh_token: "r", mailbox_address: "support@vircle.com", status: connected, needs_reauth: reauth, enabled, inbox_enabled: inbox } as Ms365MailboxRow;
}
function gmRow(connected: Connected, enabled: boolean, inbox: boolean, reauth: boolean): GmailMailboxRow | null {
  if (connected === "absent") return null;
  return { id: "g", account_id: "A", access_token: "t", access_token_expires_at: "2030-01-01T00:00:00Z", refresh_token: "r", email_address: "support@vircle.com", status: connected, needs_reauth: reauth, enabled, inbox_enabled: inbox } as GmailMailboxRow;
}

/** What the rule says, written out once more in the test's own words. */
function expected(connected: Connected, enabled: boolean, reauth: boolean): "none" | "ready" | "reconnect" | "paused" {
  if (connected === "absent") return "none";
  if (connected !== "connected") return "reconnect";
  if (reauth) return "reconnect";
  if (!enabled) return "paused";
  return "ready";
}

function summarise(state: { kind: string; problem?: string }): string {
  return state.kind === "problem" ? String(state.problem) : state.kind;
}

describe("whether Halo can send through a Microsoft 365 mailbox", () => {
  for (const connected of CONNECTED)
    for (const enabled of BOOL)
      for (const inbox of BOOL)
        for (const reauth of BOOL) {
          const want = expected(connected, enabled, reauth);
          it(`${connected}, enabled=${enabled}, inbox_enabled=${inbox}, needs_reauth=${reauth} -> ${want}`, async () => {
            const state = await loadMs365Mailbox("A", {}, ms(msRow(connected, enabled, inbox, reauth)));
            expect(summarise(state)).toBe(want);
          });
        }
});

describe("whether Halo can send through a Gmail mailbox", () => {
  for (const connected of CONNECTED)
    for (const enabled of BOOL)
      for (const inbox of BOOL)
        for (const reauth of BOOL) {
          const want = expected(connected, enabled, reauth);
          it(`${connected}, enabled=${enabled}, inbox_enabled=${inbox}, needs_reauth=${reauth} -> ${want}`, async () => {
            const state = await loadGmailMailbox("A", {}, gm(gmRow(connected, enabled, inbox, reauth)));
            expect(summarise(state)).toBe(want);
          });
        }
});

describe("the inbox switch never decides whether Halo can send", () => {
  it("is the same answer with the inbox on or off, for every state of the rest, on both providers", async () => {
    for (const connected of CONNECTED)
      for (const enabled of BOOL)
        for (const reauth of BOOL) {
          const a = await loadMs365Mailbox("A", {}, ms(msRow(connected, enabled, true, reauth)));
          const b = await loadMs365Mailbox("A", {}, ms(msRow(connected, enabled, false, reauth)));
          expect(summarise(b)).toBe(summarise(a));
          const c = await loadGmailMailbox("A", {}, gm(gmRow(connected, enabled, true, reauth)));
          const d = await loadGmailMailbox("A", {}, gm(gmRow(connected, enabled, false, reauth)));
          expect(summarise(d)).toBe(summarise(c));
        }
  });

  it("leaves a connected, unpaused mailbox with its inbox off a usable sender whose message is still marked and sent as the mailbox", async () => {
    const sent: Record<string, unknown>[] = [];
    const d = {
      loadConfig: async () => msRow("connected", true, false, false),
      getAccessToken: async () => "tok",
      sendMail: async (a: Record<string, unknown>) => void sent.push(a),
      markNeedsReauth: async () => undefined,
      throttle: { assertOpen: () => undefined, pace: async () => undefined, block: () => undefined },
      sleep: async () => undefined,
    } as unknown as Ms365SenderDeps;
    const state = await loadMs365Mailbox("A", {}, d);
    if (state.kind !== "ready") throw new Error("not ready");
    await state.send({ to: "a@example.com", subject: "s", html: "<p>h</p>", text: "h" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ fromAddress: "support@vircle.com", headers: { "X-Halo-System": "1" } });
  });
});

describe("a row read before the column existed", () => {
  it("is neither paused nor inbox-off (only === false counts)", async () => {
    const old = { ...(msRow("connected", true, true, false) as Ms365MailboxRow) };
    delete (old as { enabled?: unknown }).enabled;
    delete (old as { inbox_enabled?: unknown }).inbox_enabled;
    expect((await loadMs365Mailbox("A", {}, ms(old))).kind).toBe("ready");
    expect(mailboxSendProblem({})).toBeNull();
    expect(mailboxSendProblem({ status: "connected", enabled: null, needs_reauth: null })).toBeNull();
  });
});

describe("the pure rule", () => {
  it("names reconnect before paused, and ignores everything else", () => {
    expect(mailboxSendProblem({ status: "connected", needs_reauth: false, enabled: true })).toBeNull();
    expect(mailboxSendProblem({ status: "connected", needs_reauth: false, enabled: false })).toBe("paused");
    expect(mailboxSendProblem({ status: "connected", needs_reauth: true, enabled: false })).toBe("reconnect");
    expect(mailboxSendProblem({ status: "error", needs_reauth: false, enabled: true })).toBe("reconnect");
    expect(mailboxSendProblem({ status: "disconnected" })).toBe("reconnect");
    // @ts-expect-error inbox_enabled is not an input of the rule
    expect(mailboxSendProblem({ status: "connected", inbox_enabled: false })).toBeNull();
  });
});

describe("the chooser that orders the two providers", () => {
  const deps = (m: Ms365MailboxRow | null, g: GmailMailboxRow | null): MailboxDeps => ({ microsoft365: ms(m), gmail: gm(g) });

  it("uses a Microsoft 365 mailbox whose inbox is off and a Gmail mailbox whose inbox is off, in the usual order", async () => {
    expect(await loadMailboxState("A", {}, deps(msRow("connected", true, false, false), gmRow("connected", true, false, false)))).toMatchObject({ kind: "ready", provider: "microsoft365" });
    expect(await loadMailboxState("A", {}, deps(null, gmRow("connected", true, false, false)))).toMatchObject({ kind: "ready", provider: "gmail" });
  });

  it("falls to Gmail when the Microsoft 365 mailbox is paused, whatever its inbox says", async () => {
    for (const inbox of BOOL) {
      expect(await loadMailboxState("A", {}, deps(msRow("connected", false, inbox, false), gmRow("connected", true, false, false)))).toMatchObject({ kind: "ready", provider: "gmail" });
    }
  });

  it("reports the pause, not the inbox, when nothing can send", async () => {
    expect(await loadMailboxState("A", {}, deps(msRow("connected", false, false, false), null))).toMatchObject({ kind: "problem", provider: "microsoft365", problem: "paused" });
    expect(await loadMailboxState("A", {}, deps(null, gmRow("connected", false, true, false)))).toMatchObject({ kind: "problem", provider: "gmail", problem: "paused" });
  });
});
