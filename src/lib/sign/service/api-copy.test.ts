import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDocumentForApi, loadBundle, sendDraftForApi, type ApiCreateInput } from "./api";
import { ACCT, TPL_A, makeWorld, type World } from "./people-world";

// `copy_to` through createDocumentForApi (migration 175): the people who receive the signed copy are part of the same create (so a replay of the
// reference finds them), saved before the document is sent, and a create that fails leaves nothing behind.
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: async () => undefined }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: async () => undefined }));

let w: World;
let copiesWhenSent: string[][];

beforeEach(async () => {
  w = await makeWorld();
  copiesWhenSent = [];
  w.db.rpcHandlers.sign_send_document = async (args) => {
    // what the database would see at the moment the document is sent
    copiesWhenSent.push(w.copyRows().map((c) => c.email as string));
    const doc = w.docRows().find((d) => d.id === args.p_document)!;
    Object.assign(doc, { status: "sent", base_path: args.p_base_path, base_sha256: args.p_base_sha256, expires_at: args.p_expires_at, sent_at: "2026-10-06T08:00:00Z" });
    const people = w.signerRows().filter((s) => s.document_id === args.p_document);
    people.forEach((s, i) => Object.assign(s, { status: "sent", invited_at: "2026-10-06T08:00:00Z", _token: String(i) }));
    return {
      data: {
        reference: doc.reference,
        invited: people.map((s, i) => ({ signer_id: s.id, token: String(i + 1).repeat(64), name: s.full_name, email: s.email, phone: null, channel: s.channel, role_key: s.role_key, kind: s.kind, order_no: s.order_no })),
      },
      error: null,
    };
  };
});

// (the fake database has no cascade: rows of a deleted document would be orphans, which the real one removes with it)
const live = () => [...w.signerRows(), ...(w.copyRows() as { document_id: string }[])].filter((r) => w.docRows().some((d) => d.id === r.document_id)).length;

const input = (over: Partial<ApiCreateInput> = {}): ApiCreateInput => ({
  templateId: TPL_A,
  reference: "MERCHANT-1001",
  title: null,
  contactId: null,
  signers: [
    { roleKey: "merchant", fullName: "Ali bin Ahmad", email: "ali@kedai.example", phone: null, channel: "email", orderNo: null },
    { roleKey: "director", fullName: "Gokula", email: "g@vircle.example", phone: null, channel: "email", orderNo: 2 },
  ],
  copyTo: [
    { fullName: "Cara Lim", email: "cara@kedai.example" },
    { fullName: "Dev Raj", email: "dev@kedai.example" },
  ],
  mergeValues: {},
  message: null,
  locale: null,
  expiresInDays: null,
  signInOrder: null,
  codeRequired: null,
  send: true,
  ...over,
});

describe("createDocumentForApi with copyTo", () => {
  it("saves the people before the document is sent, and answers with them; they are not signers and are told nothing at send", async () => {
    const out = await createDocumentForApi(w.ctx, input());
    expect(out.replay).toBe(false);
    expect(copiesWhenSent).toEqual([["cara@kedai.example", "dev@kedai.example"]]);
    expect(out.copies?.map((c) => [c.full_name, c.email])).toEqual([["Cara Lim", "cara@kedai.example"], ["Dev Raj", "dev@kedai.example"]]);
    expect(out.signers).toHaveLength(2);
    // the invitations went to the signers only
    expect(w.mail.map((m) => m.to).sort()).toEqual(["ali@kedai.example", "g@vircle.example"]);
    expect(out.invitations).toHaveLength(2);
    expect(w.copyRows().every((c) => c.notified_at === null && c.document_id === out.document.id && c.account_id === ACCT)).toBe(true);
  });

  it("saves them on a draft made with send false, so sending it later finds them", async () => {
    const draft = await createDocumentForApi(w.ctx, input({ send: false }));
    expect(draft.document.status).toBe("draft");
    expect(draft.copies).toHaveLength(2);
    expect(copiesWhenSent).toEqual([]);
    const sent = await sendDraftForApi(w.ctx, draft.document.id);
    expect(copiesWhenSent).toEqual([["cara@kedai.example", "dev@kedai.example"]]);
    expect(sent.copies).toHaveLength(2);
  });

  it("makes a document with no copyTo exactly as before", async () => {
    const out = await createDocumentForApi(w.ctx, input({ copyTo: undefined }));
    expect(out.copies).toEqual([]);
    expect(w.copyRows()).toHaveLength(0);
    const empty = await createDocumentForApi(w.ctx, input({ copyTo: [], reference: "MERCHANT-1002" }));
    expect(empty.copies).toEqual([]);
  });

  it("returns the same people on a replay of the same reference and creates, saves and sends nothing", async () => {
    const first = await createDocumentForApi(w.ctx, input());
    const mails = w.mail.length;
    const again = await createDocumentForApi(w.ctx, input({ copyTo: [{ fullName: "Someone Else", email: "else@kedai.example" }] }));
    expect(again.replay).toBe(true);
    expect(again.document.id).toBe(first.document.id);
    expect(again.copies?.map((c) => c.email)).toEqual(["cara@kedai.example", "dev@kedai.example"]);
    expect(w.docRows()).toHaveLength(1);
    expect(w.copyRows()).toHaveLength(2);
    expect(w.mail).toHaveLength(mails);
    expect(w.rpcs("sign_send_document")).toHaveLength(1);
    expect((await loadBundle(w.ctx, first.document.id)).copies).toHaveLength(2);
  });

  it("is all or nothing: a copy that cannot be saved (the address of a signer, twice on the list, a bad name) deletes the draft", async () => {
    const bad: ApiCreateInput["copyTo"][] = [
      [{ fullName: "Ali again", email: "ALI@kedai.example" }],
      [{ fullName: "A", email: "x@kedai.example" }, { fullName: "B", email: "X@kedai.example" }],
      [{ fullName: " ", email: "x@kedai.example" }],
      Array.from({ length: 11 }, (_, i) => ({ fullName: `P${i}`, email: `p${i}@kedai.example` })),
    ];
    const codes = ["copy_is_signer", "copy_duplicate", "copy_name", "copy_limit"];
    for (const [i, copyTo] of bad.entries()) {
      await expect(createDocumentForApi(w.ctx, input({ copyTo }))).rejects.toMatchObject({ code: codes[i] });
      expect(w.docRows()).toHaveLength(0);
      expect(live()).toBe(0);
      expect(w.rpcs("sign_send_document")).toHaveLength(0);
    }
    expect(w.mail).toHaveLength(0);
    // the reference was never taken: the same call, corrected, works
    await expect(createDocumentForApi(w.ctx, input())).resolves.toMatchObject({ replay: false });
  });

  it("deletes the draft too when the send itself fails after the people were saved", async () => {
    w.db.rpcHandlers.sign_send_document = async () => ({ data: null, error: { message: "database said no" } });
    await expect(createDocumentForApi(w.ctx, input())).rejects.toBeDefined();
    expect(w.docRows()).toHaveLength(0);
    expect(live()).toBe(0);
  });
});
