import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SignDocumentRow, SignSignerRow } from "../types";
import type { SignCtx } from "./context";
import { FakeDb } from "./fake-db";

// The emitter's job: turn a state change into the automation trigger and the webhook, never throw, never leak
// an address, and stop an automation loop. The engine and the webhook delivery are recorders here.
const m = vi.hoisted(() => ({
  enabled: true,
  automations: vi.fn(),
  webhooks: vi.fn(),
}));

vi.mock("../feature", () => ({ signEnabled: async () => m.enabled }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: (...a: unknown[]) => m.automations(...a) }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: (...a: unknown[]) => m.webhooks(...a) }));

import { buildSignEventData, emitSignEvent, toAutomationContext } from "./outbound";

const ACCOUNT = "acct-1";
const DOC = "doc-1";
const SHA = "ab".repeat(32);
const TOKEN = "tok_SECRET_LINK_TOKEN_0123456789";

let db: FakeDb;
let ctx: SignCtx;

const roles = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director (countersign)", kind: "signer", color: 2 },
];

const doc = (over: Partial<SignDocumentRow> = {}): SignDocumentRow =>
  ({
    id: DOC,
    account_id: ACCOUNT,
    reference: "SIGN-2026-0001",
    title: "Merchant Application: Kedai Casey",
    status: "completed",
    category_id: "cat-1",
    template_version_id: "ver-1",
    contact_id: "contact-1",
    roles_snapshot: roles,
    created_at: "2026-10-01T00:00:00Z",
    sent_at: "2026-10-02T00:00:00Z",
    completed_at: "2026-10-05T00:00:00Z",
    final_sha256: SHA,
    final_path: "account-acct-1/doc-1/final/x.pdf",
    base_path: "account-acct-1/doc-1/base/x.pdf",
    merge_values: { company: "Kedai Casey", private: "do not send" },
    ...over,
  }) as unknown as SignDocumentRow;

const signer = (id: string, role: string, name: string, over: Partial<SignSignerRow> = {}) => ({
  id,
  account_id: ACCOUNT,
  document_id: DOC,
  role_key: role,
  kind: "signer",
  full_name: name,
  email: `${name.split(" ")[0].toLowerCase()}@private.example`,
  phone: "+60123456789",
  channel: "email",
  order_no: 1,
  status: "signed",
  signed_at: "2026-10-04T00:00:00Z",
  ip: "203.0.113.9",
  device: "Mozilla/5.0",
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});

beforeEach(() => {
  db = new FakeDb();
  db.seed("sign_documents", [doc() as unknown as Record<string, unknown>]);
  db.seed("sign_signers", [signer("s1", "merchant", "Casey Lee"), signer("s2", "director", "Dato Aziz", { order_no: 2, status: "sent", signed_at: null })]);
  db.seed("sign_template_versions", [{ id: "ver-1", account_id: ACCOUNT, template_id: "tpl-1" }]);
  db.seed("sign_templates", [{ id: "tpl-1", account_id: ACCOUNT, name: "Merchant Application" }]);
  db.seed("sign_categories", [{ id: "cat-1", account_id: ACCOUNT, name: "Merchant agreements" }]);
  db.seed("automations", [{ id: "a1", account_id: ACCOUNT, trigger_type: "sign_document_event", is_active: true }]);
  ctx = { admin: db.client(), accountId: ACCOUNT, userId: null, origin: "https://halo.example/", deps: {} as never, now: () => new Date("2026-10-07T00:00:00Z") };
  m.enabled = true;
  m.automations.mockReset().mockResolvedValue(undefined);
  m.webhooks.mockReset().mockResolvedValue(undefined);
});

describe("emitSignEvent: both channels", () => {
  it("dispatches the automation trigger and the webhook, for the contact, with the same document", async () => {
    await emitSignEvent(ctx, doc(), "completed");
    expect(m.automations).toHaveBeenCalledTimes(1);
    expect(m.webhooks).toHaveBeenCalledTimes(1);

    const trigger = m.automations.mock.calls[0][0];
    expect(trigger).toMatchObject({ accountId: ACCOUNT, triggerType: "sign_document_event", contactId: "contact-1" });
    expect(trigger.context.sign).toEqual({
      document_id: DOC,
      reference: "SIGN-2026-0001",
      title: "Merchant Application: Kedai Casey",
      status: "completed",
      event: "completed",
      template: "Merchant Application",
      template_id: "tpl-1",
      category_id: "cat-1",
      final_sha256: SHA,
      verify_url: `https://halo.example/verify/${DOC}`,
    });
    // the loop guard starts at one link
    expect(trigger.context.vars).toEqual({ _sign_chain_depth: 1 });

    const [, account, event, data] = m.webhooks.mock.calls[0];
    expect(account).toBe(ACCOUNT);
    expect(event).toBe("sign.completed");
    expect(data).toMatchObject({
      document_id: DOC,
      reference: "SIGN-2026-0001",
      title: "Merchant Application: Kedai Casey",
      status: "completed",
      template_id: "tpl-1",
      template_name: "Merchant Application",
      category_id: "cat-1",
      category: "Merchant agreements",
      contact_id: "contact-1",
      created_at: "2026-10-01T00:00:00Z",
      sent_at: "2026-10-02T00:00:00Z",
      completed_at: "2026-10-05T00:00:00Z",
      final_sha256: SHA,
      verify_url: `https://halo.example/verify/${DOC}`,
    });
    expect(data.signers).toEqual([
      { name: "Casey Lee", role: "Merchant", role_key: "merchant", status: "signed", signed_at: "2026-10-04T00:00:00Z" },
      { name: "Dato Aziz", role: "Director (countersign)", role_key: "director", status: "sent", signed_at: null },
    ]);
  });

  it("each event goes out as sign.<event>", async () => {
    for (const e of ["sent", "viewed", "completed", "declined", "expired", "voided"] as const) {
      m.webhooks.mockClear();
      await emitSignEvent(ctx, doc(), e);
      expect(m.webhooks.mock.calls[0][2]).toBe(`sign.${e}`);
      expect(m.automations.mock.calls.at(-1)?.[0].context.sign.event).toBe(e);
    }
  });

  it("reads the document again, so the payload shows the state after the change", async () => {
    db.tables.sign_documents = [doc({ status: "voided" }) as unknown as Record<string, unknown>];
    await emitSignEvent(ctx, doc({ status: "sent" }), "voided");
    expect(m.webhooks.mock.calls[0][3].status).toBe("voided");
    expect(m.automations.mock.calls[0][0].context.sign.status).toBe("voided");
  });

  it("a document from no template and no category still goes out", async () => {
    db.tables.sign_documents = [doc({ template_version_id: null, category_id: null, contact_id: null }) as unknown as Record<string, unknown>];
    await emitSignEvent(ctx, doc(), "sent");
    expect(m.webhooks.mock.calls[0][3]).toMatchObject({ template_id: null, template_name: null, category_id: null, category: null, contact_id: null });
    expect(m.automations.mock.calls[0][0]).toMatchObject({ contactId: null });
    expect(m.automations.mock.calls[0][0].context.sign).toMatchObject({ template: "", template_id: "", category_id: "" });
  });
});

describe("emitSignEvent: what goes out", () => {
  const everything = async (event: "sent" | "viewed" | "completed" | "declined" | "expired" | "voided") => {
    // plant things that must never travel: a link token in an event detail, a file in storage
    db.seed("sign_events", [{ id: "e1", account_id: ACCOUNT, document_id: DOC, type: "invited", detail: { token: TOKEN } }]);
    m.webhooks.mockClear();
    m.automations.mockClear();
    await emitSignEvent(ctx, doc(), event, { signerId: "s1" });
    return JSON.stringify([m.webhooks.mock.calls[0][3], m.automations.mock.calls[0][0]]);
  };

  it("carries no email address, phone number, link token, file path, IP address or merge value, for any event", async () => {
    for (const e of ["sent", "viewed", "completed", "declined", "expired", "voided"] as const) {
      const text = await everything(e);
      expect(text, e).not.toMatch(/@private\.example/);
      expect(text, e).not.toContain("+60123456789");
      expect(text, e).not.toContain(TOKEN);
      expect(text, e).not.toContain("account-acct-1/");
      expect(text, e).not.toContain("203.0.113.9");
      expect(text, e).not.toContain("Mozilla");
      expect(text, e).not.toContain("do not send");
      expect(text, e).not.toMatch(/\.pdf/);
      expect(text, e).not.toMatch(/"(email|phone|token|path|ip|device)"/);
    }
  });

  it("the fingerprint and the verify page are only on completed", async () => {
    const done = JSON.parse(await everything("completed"))[0];
    expect(done.final_sha256).toBe(SHA);
    expect(done.verify_url).toBe(`https://halo.example/verify/${DOC}`);
    const other = JSON.parse(await everything("expired"))[0];
    expect(other.final_sha256).toBeUndefined();
    expect(other.verify_url).toBeUndefined();
  });

  it("viewed and declined say who, by name and role only", async () => {
    const seen = JSON.parse(await everything("viewed"))[0];
    expect(seen.signer).toEqual({ name: "Casey Lee", role: "Merchant" });
    const declined = JSON.parse(await everything("declined"))[0];
    expect(declined.signer).toEqual({ name: "Casey Lee", role: "Merchant" });
    expect(JSON.parse(await everything("completed"))[0].signer).toBeUndefined();
  });

  it("buildSignEventData is pure: the same inputs give the same payload", () => {
    const signers = [signer("s1", "merchant", "Casey Lee")] as unknown as SignSignerRow[];
    const a = buildSignEventData(doc(), signers, "completed", "https://x.example", { templateId: null, templateName: null, categoryName: null });
    const b = buildSignEventData(doc(), signers, "completed", "https://x.example", { templateId: null, templateName: null, categoryName: null });
    expect(a).toEqual(b);
    expect(toAutomationContext(a, "completed").verify_url).toBe(`https://x.example/verify/${DOC}`);
  });
});

describe("emitSignEvent: when no automation listens", () => {
  it("does not load or run the engine, and the webhook still goes out", async () => {
    db.tables.automations = [];
    await emitSignEvent(ctx, doc(), "completed");
    expect(m.automations).not.toHaveBeenCalled();
    expect(m.webhooks).toHaveBeenCalledTimes(1);
    // an automation that is switched off, or listens to another trigger, does not count
    db.tables.automations = [
      { id: "a2", account_id: ACCOUNT, trigger_type: "sign_document_event", is_active: false },
      { id: "a3", account_id: ACCOUNT, trigger_type: "tag_added", is_active: true },
      { id: "a4", account_id: "other", trigger_type: "sign_document_event", is_active: true },
    ];
    await emitSignEvent(ctx, doc(), "completed");
    expect(m.automations).not.toHaveBeenCalled();
  });
});

describe("emitSignEvent: the flag", () => {
  it("a workspace without Doc Sign never emits", async () => {
    m.enabled = false;
    await emitSignEvent(ctx, doc(), "completed");
    expect(m.automations).not.toHaveBeenCalled();
    expect(m.webhooks).not.toHaveBeenCalled();
  });
});

describe("emitSignEvent: never throws", () => {
  it("an automation that fails does not stop the webhook, and the other way round", async () => {
    m.automations.mockRejectedValue(new Error("engine down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(emitSignEvent(ctx, doc(), "completed")).resolves.toBeUndefined();
    expect(m.webhooks).toHaveBeenCalledTimes(1);

    m.automations.mockReset().mockResolvedValue(undefined);
    m.webhooks.mockReset().mockRejectedValue(new Error("endpoint down"));
    await expect(emitSignEvent(ctx, doc(), "completed")).resolves.toBeUndefined();
    expect(m.automations).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("a broken database read, a missing document or both channels failing are swallowed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    m.automations.mockRejectedValue(new Error("a"));
    m.webhooks.mockRejectedValue(new Error("b"));
    await expect(emitSignEvent(ctx, doc(), "completed")).resolves.toBeUndefined();
    const broken = { ...ctx, admin: { from: () => { throw new Error("db gone"); } } as never };
    await expect(emitSignEvent(broken, doc(), "completed")).resolves.toBeUndefined();
    db.tables.sign_documents = [];
    await expect(emitSignEvent(ctx, doc(), "sent")).resolves.toBeUndefined(); // falls back to the caller's copy
    spy.mockRestore();
  });
});

describe("emitSignEvent: the loop guard", () => {
  it("passes the depth on, one deeper each time", async () => {
    await emitSignEvent({ ...ctx, chainDepth: 1 }, doc(), "sent");
    expect(m.automations.mock.calls[0][0].context.vars).toEqual({ _sign_chain_depth: 2 });
    await emitSignEvent({ ...ctx, chainDepth: 2 }, doc(), "sent");
    expect(m.automations.mock.calls[1][0].context.vars).toEqual({ _sign_chain_depth: 3 });
  });

  it("stops dispatching the trigger at the limit; the webhook still goes out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await emitSignEvent({ ...ctx, chainDepth: 3 }, doc(), "sent");
    expect(m.automations).not.toHaveBeenCalled();
    expect(m.webhooks).toHaveBeenCalledTimes(1);
    await emitSignEvent({ ...ctx, chainDepth: 9 }, doc(), "sent");
    expect(m.automations).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
