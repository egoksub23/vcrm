import { describe, expect, it } from "vitest";

import type { MailboxState, OutgoingEmail } from "./mailbox-types";
import { MailSendError } from "./send-reason";
import { canSendWorkspaceEmail, chooseEmailTransport, sendWorkspaceEmail, type WorkspaceEmail, type WorkspaceMailDeps } from "./workspace-mail";

// The one workspace-aware sender: a ready connected mailbox first (whatever its inbox switch says: that is not an input), else the platform sender,
// else "not set up"; always a result, never a throw; the sender name and reply-to are the workspace's unless the caller names its own.

interface World {
  deps: WorkspaceMailDeps;
  platform: OutgoingEmail[];
  mailbox: OutgoingEmail[];
}

function world(opts: { state?: MailboxState | (() => Promise<MailboxState>); platform?: boolean; platformFails?: Error; mailboxFails?: Error; noMailboxDep?: boolean; identity?: () => Promise<{ fromName?: string | null; replyTo?: string | null }> } = {}): World {
  const platform: OutgoingEmail[] = [];
  const mailbox: OutgoingEmail[] = [];
  const state = opts.state ?? ({ kind: "ready", provider: "microsoft365", address: "support@vircle.com", attachBytes: 2.5 * 1024 * 1024, send: async (m: OutgoingEmail) => {
    if (opts.mailboxFails) throw opts.mailboxFails;
    mailbox.push(m);
  } } as MailboxState);
  const resolved = typeof state === "function" ? state : async () => state;
  const deps: WorkspaceMailDeps = {
    emailConfigured: () => opts.platform ?? false,
    sendEmail: async (a) => {
      if (opts.platformFails) throw opts.platformFails;
      platform.push(a as unknown as OutgoingEmail);
    },
    loadIdentity: opts.identity ?? (async () => ({ fromName: "Vircle", replyTo: "hello@vircle.example" })),
    ...(opts.noMailboxDep ? {} : { mailbox: resolved }),
  };
  return { deps, platform, mailbox };
}

const mail: WorkspaceEmail = { to: "ali@example.com", subject: "Hello", html: "<p>hi</p>", text: "hi" };

describe("which way a workspace's email goes", () => {
  it("goes through a ready mailbox even when the platform sender is set up, from the workspace's name and reply-to", async () => {
    const w = world({ platform: true });
    expect(await sendWorkspaceEmail("A", mail, w.deps)).toEqual({ status: "sent", via: "mailbox", provider: "microsoft365", from: "support@vircle.com" });
    expect(w.platform).toHaveLength(0);
    expect(w.mailbox[0]).toMatchObject({ to: "ali@example.com", subject: "Hello", fromName: "Vircle", replyTo: "hello@vircle.example" });
  });

  it("goes through the platform sender when there is no mailbox", async () => {
    const w = world({ platform: true, state: { kind: "none" } });
    expect(await sendWorkspaceEmail("A", mail, w.deps)).toEqual({ status: "sent", via: "platform", provider: null, from: null });
    expect(w.platform).toHaveLength(1);
    expect(w.platform[0]).toMatchObject({ fromName: "Vircle", replyTo: "hello@vircle.example" });
  });

  it("goes through the platform sender when the dependencies have no mailbox at all", async () => {
    const w = world({ platform: true, noMailboxDep: true });
    expect((await sendWorkspaceEmail("A", mail, w.deps)).via).toBe("platform");
  });

  it("falls back to the platform sender when the mailbox is paused, needs reconnecting or cannot be read", async () => {
    for (const problem of ["paused", "reconnect"] as const) {
      const w = world({ platform: true, state: { kind: "problem", provider: "gmail", address: "sales@vircle.com", problem } });
      expect(await sendWorkspaceEmail("A", mail, w.deps)).toMatchObject({ status: "sent", via: "platform" });
      expect(w.platform).toHaveLength(1);
    }
    const broken = world({ platform: true, state: async () => { throw new Error("database down"); } });
    expect(await sendWorkspaceEmail("A", mail, broken.deps)).toMatchObject({ status: "sent", via: "platform" });
  });

  it("says why when nothing can send: the mailbox's problem when one is connected, 'not set up' when none is", async () => {
    const paused = world({ state: { kind: "problem", provider: "gmail", address: "sales@vircle.com", problem: "paused" } });
    expect(await sendWorkspaceEmail("A", mail, paused.deps)).toEqual({ status: "failed", via: "none", provider: "gmail", from: null, detail: "mailbox_paused: mailbox sales@vircle.com" });
    const reconnect = world({ state: { kind: "problem", provider: "microsoft365", address: "support@vircle.com", problem: "reconnect" } });
    expect((await sendWorkspaceEmail("A", mail, reconnect.deps)).detail).toBe("mailbox_reconnect: mailbox support@vircle.com");
    const none = world({ state: { kind: "none" } });
    const r = await sendWorkspaceEmail("A", mail, none.deps);
    expect(r).toMatchObject({ status: "not_configured", via: "none" });
    expect(r.detail).toMatch(/^not_set_up: /);
    expect(r.detail).not.toMatch(/RESEND/);
  });
});

describe("a send that fails is a result, never a throw", () => {
  it("reports the named reason of a mailbox failure, and plain text for one it cannot name", async () => {
    const limited = world({ mailboxFails: new MailSendError("daily_limit", "Daily user sending quota exceeded.") });
    expect(await sendWorkspaceEmail("A", mail, limited.deps)).toEqual({ status: "failed", via: "mailbox", provider: "microsoft365", from: "support@vircle.com", detail: "daily_limit: Daily user sending quota exceeded." });
    const odd = world({ mailboxFails: new Error("something odd") });
    expect((await sendWorkspaceEmail("A", mail, odd.deps)).detail).toBe("something odd");
  });

  it("reports a platform failure the same way, and does not then try the mailbox", async () => {
    const w = world({ platform: true, state: { kind: "none" }, platformFails: new Error("resend down") });
    expect(await sendWorkspaceEmail("A", mail, w.deps)).toMatchObject({ status: "failed", via: "platform", detail: "resend down" });
  });

  it("does not fall back to the platform sender after a mailbox that accepted the job failed (the person would otherwise be emailed twice by two senders)", async () => {
    const w = world({ platform: true, mailboxFails: new Error("boom") });
    expect((await sendWorkspaceEmail("A", mail, w.deps)).status).toBe("failed");
    expect(w.platform).toHaveLength(0);
  });

  it("reports a message builder that throws", async () => {
    const w = world({ platform: true });
    const r = await sendWorkspaceEmail("A", () => { throw new Error("bad template"); }, w.deps);
    expect(r).toMatchObject({ status: "failed", detail: "bad template" });
  });
});

describe("the sender name and reply-to", () => {
  it("are the workspace's, unless the caller or the call names its own", async () => {
    const a = world({ platform: true, state: { kind: "none" } });
    await sendWorkspaceEmail("A", { ...mail, fromName: "Ops", replyTo: "ops@vircle.example" }, a.deps);
    expect(a.platform[0]).toMatchObject({ fromName: "Ops", replyTo: "ops@vircle.example" });
    const b = world({ platform: true, state: { kind: "none" } });
    await sendWorkspaceEmail("A", { ...mail, fromName: "Ops" }, b.deps, { fromName: "Sender from the option" });
    expect(b.platform[0]).toMatchObject({ fromName: "Sender from the option", replyTo: "hello@vircle.example" });
    const c = world({ platform: true, state: { kind: "none" } });
    await sendWorkspaceEmail("A", mail, c.deps, { fromName: null });
    expect(c.platform[0]).toMatchObject({ fromName: "Vircle" });
  });

  it("are left off when the workspace has none (the mail still goes)", async () => {
    const w = world({ platform: true, state: { kind: "none" }, identity: async () => ({}) });
    expect((await sendWorkspaceEmail("A", mail, w.deps)).status).toBe("sent");
  });
});

describe("files", () => {
  it("are told the budget of the way the message goes: the mailbox's, capped by the feature's; the platform's is the feature's cap", async () => {
    const seen: number[] = [];
    const builder = ({ attachBytes }: { attachBytes: number }): WorkspaceEmail => {
      seen.push(attachBytes);
      return mail;
    };
    await sendWorkspaceEmail("A", builder, world().deps);
    await sendWorkspaceEmail("A", builder, world().deps, { attachCap: 1024 });
    await sendWorkspaceEmail("A", builder, world({ platform: true, state: { kind: "none" } }).deps, { attachCap: 20 * 1024 * 1024 });
    await sendWorkspaceEmail("A", builder, world({ platform: true, state: { kind: "none" } }).deps);
    expect(seen).toEqual([2.5 * 1024 * 1024, 1024, 20 * 1024 * 1024, Infinity]);
  });

  it("go on the message as the caller gave them, and are not added when there are none", async () => {
    const w = world();
    await sendWorkspaceEmail("A", { ...mail, attachments: [{ filename: "a.pdf", content: "AAAA" }] }, w.deps);
    await sendWorkspaceEmail("A", { ...mail, attachments: [] }, w.deps);
    expect(w.mailbox[0].attachments).toEqual([{ filename: "a.pdf", content: "AAAA" }]);
    expect(w.mailbox[1]).not.toHaveProperty("attachments");
  });
});

describe("choosing without sending", () => {
  it("reports the transport and whether anything can send", async () => {
    expect(await chooseEmailTransport(world().deps, "A")).toMatchObject({ via: "mailbox", provider: "microsoft365", address: "support@vircle.com" });
    expect(await chooseEmailTransport(world({ platform: true, state: { kind: "none" } }).deps, "A")).toEqual({ via: "platform", skipped: null });
    expect(await canSendWorkspaceEmail("A", world({ state: { kind: "none" } }).deps)).toBe(false);
    expect(await canSendWorkspaceEmail("A", world({ platform: true, state: { kind: "none" } }).deps)).toBe(true);
    expect(await canSendWorkspaceEmail("A", world().deps)).toBe(true);
    // a paused mailbox with no platform sender cannot send
    expect(await canSendWorkspaceEmail("A", world({ state: { kind: "problem", provider: "gmail", address: "a@b.co", problem: "paused" } }).deps)).toBe(false);
  });
});
