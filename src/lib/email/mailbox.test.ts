import { describe, expect, it } from "vitest";

import type { GmailSenderDeps } from "./gmail-sender";
import { loadMailboxState, type MailboxDeps } from "./mailbox";
import type { Ms365SenderDeps } from "./ms365-sender";

// Which connected mailbox Doc Sign mail goes through: Microsoft 365 first, then Gmail, then a connected one that cannot send, then none.

const ms = (row: Record<string, unknown> | null | "boom") =>
  ({
    loadConfig: async () => {
      if (row === "boom") throw new Error("database down");
      return row;
    },
  }) as unknown as Ms365SenderDeps;
const gm = (row: Record<string, unknown> | null | "boom") =>
  ({
    loadConfig: async () => {
      if (row === "boom") throw new Error("database down");
      return row;
    },
  }) as unknown as GmailSenderDeps;

const MS_OK = { id: "e", account_id: "A", mailbox_address: "support@vircle.com", status: "connected", needs_reauth: false, enabled: true };
const GM_OK = { id: "g", account_id: "A", email_address: "sales@vircle.com", status: "connected", needs_reauth: false, enabled: true };

const deps = (a: Parameters<typeof ms>[0], b: Parameters<typeof gm>[0]): MailboxDeps => ({ microsoft365: ms(a), gmail: gm(b) });

describe("which mailbox is chosen", () => {
  it("is Microsoft 365 when both are connected and ready", async () => {
    expect(await loadMailboxState("A", {}, deps(MS_OK, GM_OK))).toMatchObject({ kind: "ready", provider: "microsoft365", address: "support@vircle.com" });
  });

  it("is Gmail when only Gmail is connected", async () => {
    expect(await loadMailboxState("A", {}, deps(null, GM_OK))).toMatchObject({ kind: "ready", provider: "gmail", address: "sales@vircle.com" });
  });

  it("is Gmail when the Microsoft 365 mailbox needs reconnecting and Gmail is fine", async () => {
    expect(await loadMailboxState("A", {}, deps({ ...MS_OK, needs_reauth: true }, GM_OK))).toMatchObject({ kind: "ready", provider: "gmail" });
  });

  it("is the Microsoft 365 problem when neither can send", async () => {
    expect(await loadMailboxState("A", {}, deps({ ...MS_OK, needs_reauth: true }, { ...GM_OK, enabled: false }))).toMatchObject({ kind: "problem", provider: "microsoft365", problem: "reconnect" });
    expect(await loadMailboxState("A", {}, deps(null, { ...GM_OK, enabled: false }))).toMatchObject({ kind: "problem", provider: "gmail", problem: "paused" });
  });

  it("is none when nothing is connected", async () => {
    expect(await loadMailboxState("A", {}, deps(null, null))).toEqual({ kind: "none" });
  });

  it("still uses the mailbox it could read when the other cannot be read", async () => {
    expect(await loadMailboxState("A", {}, deps("boom", GM_OK))).toMatchObject({ kind: "ready", provider: "gmail" });
  });

  it("throws, rather than say 'not set up', when a connection could not be read and nothing else can send", async () => {
    await expect(loadMailboxState("A", {}, deps("boom", null))).rejects.toThrow("database down");
  });
});
