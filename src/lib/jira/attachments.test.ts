import { describe, expect, it } from "vitest";

import { pullAttachments, sendTicketAttachment, sha256, unseenAttachments, type AttachmentStorage } from "./attachments";
import { JiraPermissionError, JiraRateLimitError } from "./errors";
import { syncIssue } from "./sync";
import { fakeClient, issue, linkRow, makeContext, MemoryStore } from "./test-fakes";
import type { JiraAttachmentRef, JiraSettings } from "./types";

const ACCT = "acct-1";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const PDF = new TextEncoder().encode("%PDF-1.4 body");

class FakeStorage implements AttachmentStorage {
  files = new Map<string, Uint8Array>();
  uploads: { path: string; contentType: string }[] = [];
  removed: string[] = [];
  failUpload = false;
  async download(path: string) {
    return this.files.get(path) ?? null;
  }
  async upload(path: string, data: Uint8Array, contentType: string) {
    if (this.failUpload) return { error: "quota" };
    this.files.set(path, data);
    this.uploads.push({ path, contentType });
    return { error: null };
  }
  async remove(path: string) {
    this.removed.push(path);
    this.files.delete(path);
  }
  publicUrl(path: string) {
    return `https://storage.example/${path}`;
  }
}

const ON: Partial<JiraSettings> = { direction: { attachments: true } as never };

function setup(settings: Partial<JiraSettings> = ON, script: Parameters<typeof fakeClient>[0] = {}) {
  const store = new MemoryStore();
  store.links.push(linkRow({ id: "L1", issue_id: "10001", issue_key: "ENG-1" }));
  const storage = new FakeStorage();
  const fake = fakeClient(script);
  const ctx = makeContext(store, fake.client, settings);
  const actx = { store, client: fake.client, storage, connection: ctx.connection, settings: ctx.settings, now: ctx.now };
  return { store, storage, fake, ctx, actx };
}

function addAttachment(s: ReturnType<typeof setup>, over: Partial<{ id: string; filename: string; mime: string; size: number; data: Uint8Array; source: string; path: string }> = {}) {
  const path = over.path ?? `account-${ACCT}/tickets/171-${over.filename ?? "shot.png"}`;
  const data = over.data ?? PNG;
  s.storage.files.set(path, data);
  const row = {
    id: over.id ?? "att-1",
    ticket_id: "t-1",
    account_id: ACCT,
    storage_path: path,
    url: `https://storage.example/${path}`,
    filename: over.filename ?? "shot.png",
    mime_type: over.mime ?? "image/png",
    size_bytes: over.size ?? data.byteLength,
    source: over.source ?? "vircle",
  };
  s.store.ticketAttachments.push(row);
  return row;
}

const uploads = (s: ReturnType<typeof setup>) => s.fake.calls.filter((c) => c.method === "uploadAttachment");

describe("Vircle -> Jira: sendTicketAttachment", () => {
  it("uploads the file from our bucket and records the map row before any webhook can announce it", async () => {
    const s = setup();
    addAttachment(s);
    const r = await sendTicketAttachment(s.actx, { attachmentId: "att-1" });
    expect(r).toEqual([{ linkId: "L1", key: "ENG-1", ok: true, code: "sent" }]);
    expect(uploads(s)).toHaveLength(1);
    expect(uploads(s)[0].args).toEqual(["10001", { filename: "shot.png", contentType: "image/png", data: PNG }]);
    expect(s.store.attachmentMaps).toEqual([
      expect.objectContaining({ link_id: "L1", ticket_attachment_id: "att-1", jira_attachment_id: "att-99", direction: "to_jira", status: "synced", content_hash: sha256(PNG) }),
    ]);
    expect(s.store.events.some((e) => e.kind === "attachment_sent")).toBe(true);
  });

  it("does nothing without the attachments switch (default off), and 'send all new' needs its own switch", async () => {
    const off = setup({});
    addAttachment(off);
    expect(await sendTicketAttachment(off.actx, { attachmentId: "att-1" })).toEqual([{ linkId: "L1", key: "ENG-1", ok: false, code: "toggle_off" }]);
    expect(uploads(off)).toHaveLength(0);

    const manualOnly = setup(ON);
    addAttachment(manualOnly);
    const auto = await sendTicketAttachment(manualOnly.actx, { attachmentId: "att-1", auto: true });
    expect(auto[0].code).toBe("toggle_off");
    const both = setup({ direction: { attachments: true, attachments_auto: true } as never });
    addAttachment(both);
    expect((await sendTicketAttachment(both.actx, { attachmentId: "att-1", auto: true }))[0].code).toBe("sent");
  });

  it("prevents duplicates: the same attachment twice, and the same bytes under another name", async () => {
    const s = setup();
    addAttachment(s);
    await sendTicketAttachment(s.actx, { attachmentId: "att-1" });
    expect((await sendTicketAttachment(s.actx, { attachmentId: "att-1" }))[0]).toMatchObject({ ok: true, code: "already" });
    addAttachment(s, { id: "att-2", filename: "copy.png" });
    expect((await sendTicketAttachment(s.actx, { attachmentId: "att-2" }))[0]).toMatchObject({ ok: true, code: "duplicate" });
    expect(uploads(s)).toHaveLength(1);
  });

  it("enforces the size cap: 10 MB by default, the site's limit when it says", async () => {
    const big = setup();
    addAttachment(big, { size: 11 * 1024 * 1024 });
    expect((await sendTicketAttachment(big.actx, { attachmentId: "att-1" }))[0].code).toBe("too_large");
    expect(uploads(big)).toHaveLength(0);

    const site = setup(ON, { getAttachmentMeta: async () => ({ enabled: true, uploadLimit: 8 }) });
    addAttachment(site); // 11 bytes
    expect((await sendTicketAttachment(site.actx, { attachmentId: "att-1" }))[0].code).toBe("too_large");

    // the real size counts, not the row's claim
    const liar = setup(ON, { getAttachmentMeta: async () => ({ enabled: true, uploadLimit: 8 }) });
    addAttachment(liar, { size: 1 });
    expect((await sendTicketAttachment(liar.actx, { attachmentId: "att-1" }))[0].code).toBe("too_large");
    expect(uploads(liar)).toHaveLength(0);

    const disabled = setup(ON, { getAttachmentMeta: async () => ({ enabled: false }) });
    addAttachment(disabled);
    expect((await sendTicketAttachment(disabled.actx, { attachmentId: "att-1" }))[0].code).toBe("attachments_disabled");
  });

  it("refuses HTML, mismatched content and made-up types before anything leaves", async () => {
    for (const [over, code] of [
      [{ mime: "text/html", data: new TextEncoder().encode("<html>") }, "mime_refused"],
      [{ mime: "image/svg+xml", filename: "a.svg", data: new TextEncoder().encode("<svg/>") }, "mime_refused"],
      [{ mime: "image/png", data: PDF }, "mime_mismatch"],
      [{ mime: "text/plain", filename: "n.txt", data: new TextEncoder().encode("<!doctype html><script>") }, "active_content"],
      [{ mime: "nonsense", data: PNG }, "mime_refused"],
    ] as const) {
      const s = setup();
      addAttachment(s, over as never);
      expect((await sendTicketAttachment(s.actx, { attachmentId: "att-1" }))[0].code, JSON.stringify(over.mime)).toBe(code);
      expect(uploads(s)).toHaveLength(0);
    }
  });

  it("caps an issue at 20 files", async () => {
    const s = setup();
    addAttachment(s);
    for (let i = 0; i < 20; i++) s.store.attachmentMaps.push({ id: `m${i}`, account_id: ACCT, link_id: "L1", ticket_attachment_id: null, jira_attachment_id: `x${i}`, direction: "to_jira", status: "synced", content_hash: `h${i}`, filename: null, mime_type: null, size_bytes: null, jira_url: null, error: null });
    expect((await sendTicketAttachment(s.actx, { attachmentId: "att-1" }))[0].code).toBe("issue_full");
    // skipped and duplicate rows do not count against the 20
    s.store.attachmentMaps.pop();
    expect((await sendTicketAttachment(s.actx, { attachmentId: "att-1" }))[0].code).toBe("sent");
  });

  it("never follows a URL: only a path under account-<id>/tickets/, and never a file that came from Jira", async () => {
    const s = setup();
    addAttachment(s, { path: "https://evil.example/x.png" });
    expect((await sendTicketAttachment(s.actx, { attachmentId: "att-1" }))[0].code).toBe("bad_path");
    const t = setup();
    addAttachment(t, { path: `account-${ACCT}/kb/x.png` });
    expect((await sendTicketAttachment(t.actx, { attachmentId: "att-1" }))[0].code).toBe("bad_path");
    const j = setup();
    addAttachment(j, { source: "jira" });
    expect((await sendTicketAttachment(j.actx, { attachmentId: "att-1" }))[0].code).toBe("from_jira");
    expect(uploads(s).length + uploads(t).length + uploads(j).length).toBe(0);
  });

  it("another workspace's attachment is not found", async () => {
    const s = setup();
    const row = addAttachment(s);
    row.account_id = "acct-2";
    expect((await sendTicketAttachment(s.actx, { attachmentId: "att-1" }))[0].code).toBe("not_found");
  });

  it("only healthy links get the file; a chosen link limits it to that link", async () => {
    const s = setup();
    s.store.links.push(linkRow({ id: "L2", issue_id: "10002", issue_key: "ENG-2", sync_state: "paused" }), linkRow({ id: "L3", issue_id: "10003", issue_key: "ENG-3" }));
    addAttachment(s);
    const all = await sendTicketAttachment(s.actx, { attachmentId: "att-1" });
    expect(all.map((r) => [r.key, r.code])).toEqual([["ENG-1", "sent"], ["ENG-3", "sent"]]);
    expect(uploads(s).map((c) => c.args[0])).toEqual(["10001", "10003"]);
    const one = setup();
    one.store.links.push(linkRow({ id: "L3", issue_id: "10003", issue_key: "ENG-3" }));
    addAttachment(one);
    expect((await sendTicketAttachment(one.actx, { attachmentId: "att-1", linkId: "L3" })).map((r) => r.key)).toEqual(["ENG-3"]);
  });

  it("a per-project override switches attachments on for that project only", async () => {
    const s = setup({ project_overrides: { ENG: { direction: { attachments: true } } } });
    s.store.links.push(linkRow({ id: "L2", issue_id: "10002", issue_key: "OPS-1", project_key: "OPS" }));
    addAttachment(s);
    const r = await sendTicketAttachment(s.actx, { attachmentId: "att-1" });
    expect(r.map((x) => [x.key, x.code])).toEqual([["ENG-1", "sent"], ["OPS-1", "toggle_off"]]);
  });

  it("Jira refusing (403) is reported and logged; a rate limit goes back to the queue", async () => {
    const denied = setup(ON, { uploadAttachment: async () => { throw new JiraPermissionError(); } });
    addAttachment(denied);
    expect((await sendTicketAttachment(denied.actx, { attachmentId: "att-1" }))[0].code).toBe("permission");
    expect(denied.store.events.some((e) => e.kind === "attachment_send_failed")).toBe(true);
    expect(denied.store.attachmentMaps).toEqual([]);

    const limited = setup(ON, { uploadAttachment: async () => { throw new JiraRateLimitError(5000); } });
    addAttachment(limited);
    await expect(sendTicketAttachment(limited.actx, { attachmentId: "att-1" })).rejects.toBeInstanceOf(JiraRateLimitError);
  });
});

// ---------------------------------------------------------------------------

function ref(over: Partial<JiraAttachmentRef> = {}): JiraAttachmentRef {
  return { id: "7001", filename: "screen.png", mimeType: "image/png", size: 11, created: "2026-09-20T10:00:00.000+0000", content: "https://api.atlassian.com/ex/jira/x/rest/api/3/attachment/content/7001", ...over };
}
const withAttachments = (list: JiraAttachmentRef[]) => {
  const i = issue({});
  i.fields.attachment = list;
  return i;
};

describe("Jira -> Vircle: pullAttachments", () => {
  const dl = (data: Uint8Array, type = "image/png") => async () => ({ ok: true as const, data, contentType: type });

  it("stores a new file as a ticket attachment tagged 'from Jira' and records the map row", async () => {
    const s = setup(ON, { downloadAttachment: dl(PNG) });
    const link = s.store.links[0];
    const r = await pullAttachments(s.actx, link, withAttachments([ref()]));
    expect(r).toMatchObject({ stored: 1, skipped: 0 });
    expect(s.storage.uploads).toHaveLength(1);
    const path = s.storage.uploads[0].path;
    expect(path).toMatch(new RegExp(`^account-${ACCT}/tickets/\\d+-screen\\.png$`));
    expect(s.store.ticketAttachments).toEqual([expect.objectContaining({ source: "jira", jira_attachment_id: "7001", filename: "screen.png", mime_type: "image/png", storage_path: path })]);
    expect(s.store.attachmentMaps).toEqual([expect.objectContaining({ direction: "from_jira", status: "synced", jira_attachment_id: "7001", content_hash: sha256(PNG) })]);
    expect(s.fake.calls.find((c) => c.method === "downloadAttachment")!.args).toEqual(["7001", 16 * 1024 * 1024]);
  });

  it("is idempotent: a file already seen is not downloaded again", async () => {
    const s = setup(ON, { downloadAttachment: dl(PNG) });
    const link = s.store.links[0];
    await pullAttachments(s.actx, link, withAttachments([ref()]));
    const again = await pullAttachments(s.actx, link, withAttachments([ref()]));
    expect(again.stored).toBe(0);
    expect(s.fake.calls.filter((c) => c.method === "downloadAttachment")).toHaveLength(1);
  });

  it("does nothing while the switch is off", async () => {
    const s = setup({}, { downloadAttachment: dl(PNG) });
    const r = await pullAttachments(s.actx, s.store.links[0], withAttachments([ref()]));
    expect(r.stored).toBe(0);
    expect(s.fake.calls.filter((c) => c.method === "downloadAttachment")).toHaveLength(0);
  });

  it("a type outside the bucket's allow-list is recorded as 'skipped (type)' with a link to Jira, and never downloaded", async () => {
    const s = setup(ON, { downloadAttachment: dl(PNG) });
    const link = s.store.links[0];
    const r = await pullAttachments(s.actx, link, withAttachments([ref({ id: "1", filename: "run.exe", mimeType: "application/x-msdownload" }), ref({ id: "2", filename: "page.html", mimeType: "text/html" }), ref({ id: "3", filename: "blob", mimeType: "application/octet-stream" })]));
    expect(r).toMatchObject({ stored: 0, skipped: 3 });
    expect(s.fake.calls.filter((c) => c.method === "downloadAttachment")).toHaveLength(0);
    expect(s.store.ticketAttachments).toEqual([]);
    expect(s.store.attachmentMaps.map((m) => [m.status, m.error])).toEqual([["skipped_type", "type"], ["skipped_type", "type"], ["skipped_type", "type"]]);
    expect(s.store.attachmentMaps[0].jira_url).toMatch(/^https:\/\/api\.atlassian\.com\//);
    // seen once, not retried on the next sync
    const again = await pullAttachments(s.actx, link, withAttachments([ref({ id: "1", mimeType: "application/x-msdownload" })]));
    expect(again.skipped).toBe(0);
  });

  it("a file over 16 MB is skipped by its declared size, or by the download refusing it", async () => {
    const s = setup(ON, { downloadAttachment: async () => ({ ok: false, reason: "too_large" }) });
    const link = s.store.links[0];
    const r = await pullAttachments(s.actx, link, withAttachments([ref({ id: "1", size: 20 * 1024 * 1024 }), ref({ id: "2" })]));
    expect(r.skipped).toBe(2);
    expect(s.fake.calls.filter((c) => c.method === "downloadAttachment")).toHaveLength(1); // the big one never asked
    expect(s.store.attachmentMaps.map((m) => m.status)).toEqual(["skipped_size", "skipped_size"]);
  });

  it("content that does not match its declared type is not stored", async () => {
    const s = setup(ON, { downloadAttachment: dl(new TextEncoder().encode("<html><script>alert(1)</script></html>")) });
    const r = await pullAttachments(s.actx, s.store.links[0], withAttachments([ref()]));
    expect(r.stored).toBe(0);
    expect(s.store.ticketAttachments).toEqual([]);
    expect(s.storage.uploads).toEqual([]);
    expect(s.store.attachmentMaps[0]).toMatchObject({ status: "skipped_type", error: "mime_mismatch" });
  });

  it("our own upload coming back is recognised by its hash and not stored twice", async () => {
    const s = setup(ON, { downloadAttachment: dl(PNG) });
    const link = s.store.links[0];
    addAttachment(s);
    await sendTicketAttachment(s.actx, { attachmentId: "att-1" });
    // the webhook beat the map row in real life; here the issue simply lists a second id for the same bytes
    const r = await pullAttachments(s.actx, link, withAttachments([ref({ id: "7777" })]));
    expect(r).toMatchObject({ stored: 0, duplicates: 1 });
    expect(s.store.ticketAttachments.filter((a) => a.source === "jira")).toEqual([]);
    expect(s.store.attachmentMaps.find((m) => m.jira_attachment_id === "7777")).toMatchObject({ status: "duplicate" });
  });

  it("the id Vircle uploaded is in the map, so the same issue read is not pulled back", async () => {
    const s = setup(ON, { downloadAttachment: dl(PNG) });
    addAttachment(s);
    await sendTicketAttachment(s.actx, { attachmentId: "att-1" });
    const r = await pullAttachments(s.actx, s.store.links[0], withAttachments([ref({ id: "att-99" })]));
    expect(r.stored + r.skipped + r.duplicates).toBe(0);
    expect(s.fake.calls.filter((c) => c.method === "downloadAttachment")).toHaveLength(0);
  });

  it("takes five files a run and says there is more", async () => {
    const s = setup(ON, { downloadAttachment: async (id) => ({ ok: true, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, Number(id)]), contentType: "image/png" }) });
    const list = Array.from({ length: 8 }, (_, i) => ref({ id: String(100 + i), filename: `p${i}.png` }));
    const r = await pullAttachments(s.actx, s.store.links[0], withAttachments(list));
    expect(r).toMatchObject({ stored: 5, more: true });
    const next = await pullAttachments(s.actx, s.store.links[0], withAttachments(list));
    expect(next).toMatchObject({ stored: 3, more: false });
  });

  it("a ticket holds at most 20 files: the rest are recorded as skipped", async () => {
    const s = setup(ON, { downloadAttachment: dl(PNG) });
    for (let i = 0; i < 20; i++) s.store.ticketAttachments.push({ id: `a${i}`, ticket_id: "t-1", account_id: ACCT, storage_path: `p${i}`, url: "u", filename: "f", mime_type: "image/png", size_bytes: 1 });
    const r = await pullAttachments(s.actx, s.store.links[0], withAttachments([ref()]));
    expect(r).toMatchObject({ stored: 0, skipped: 1 });
    expect(s.store.attachmentMaps[0].status).toBe("skipped_cap");
  });

  it("a storage failure leaves nothing behind; a rate limit is retried later, unrecorded", async () => {
    const s = setup(ON, { downloadAttachment: dl(PNG) });
    s.storage.failUpload = true;
    const r = await pullAttachments(s.actx, s.store.links[0], withAttachments([ref()]));
    expect(r.stored).toBe(0);
    expect(s.store.ticketAttachments).toEqual([]);
    expect(s.store.attachmentMaps[0]).toMatchObject({ status: "failed", error: "storage" });

    const limited = setup(ON, { downloadAttachment: async () => { throw new JiraRateLimitError(5000); } });
    await expect(pullAttachments(limited.actx, limited.store.links[0], withAttachments([ref()]))).rejects.toBeInstanceOf(JiraRateLimitError);
    expect(limited.store.attachmentMaps).toEqual([]);
  });

  it("only files added after the link count (what was attached before linking is history)", () => {
    const i = withAttachments([ref({ id: "1", created: "2026-09-19T10:00:00.000+0000" }), ref({ id: "2", created: "2026-09-20T09:30:00.000+0000" }), ref({ id: "3", created: undefined })]);
    expect(unseenAttachments(i, [], "2026-09-20T09:00:00.000Z").map((a) => a.id)).toEqual(["2", "3"]);
    expect(unseenAttachments(i, [], null).map((a) => a.id)).toEqual(["1", "2", "3"]);
    expect(unseenAttachments(i, [{ jira_attachment_id: "2" }], null).map((a) => a.id)).toEqual(["1", "3"]);
  });
});

describe("the sync worker queues the download instead of doing it inline", () => {
  it("asks for the attachment field, queues ONE pull job for new files and none when off", async () => {
    const seen: string[][] = [];
    const script = {
      getIssue: async (_id: string, fields?: never) => {
        seen.push(fields as unknown as string[]);
        return withAttachments([ref({ created: "2026-09-20T09:59:00.000+0000" })]);
      },
    };
    const on = setup({ direction: { attachments: true } as never }, script);
    on.store.links[0].created_at = "2026-09-20T09:00:00.000Z";
    await syncIssue(on.ctx, "10001", { comments: false });
    expect(seen[0]).toContain("attachment");
    expect(on.store.jobs.map((j) => [j.kind, j.payload, j.dedupe])).toEqual([["pull_attachments", { link_id: "L1" }, "pullatt:L1"]]);
    await syncIssue(on.ctx, "10001", { comments: false });
    expect(on.store.jobs).toHaveLength(1); // coalesced

    const off = setup({}, script);
    await syncIssue(off.ctx, "10001", { comments: false });
    expect(seen.at(-1)).not.toContain("attachment");
    expect(off.store.jobs).toEqual([]);
  });
});
