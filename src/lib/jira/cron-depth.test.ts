import { describe, expect, it } from "vitest";

import { processJob, type CronContext } from "./cron";
import type { FieldMappingRow } from "./field-mapping";
import { fakeClient, issue, linkRow, makeContext, MemoryStore } from "./test-fakes";

// The four job kinds migration 087 adds, as the queue runs them.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

function setup(script: Parameters<typeof fakeClient>[0] = {}, settings: Parameters<typeof makeContext>[2] = {}) {
  const store = new MemoryStore();
  store.links.push(linkRow({ id: "L1" }));
  const fake = fakeClient(script);
  const uploads: string[] = [];
  const base = makeContext(store, fake.client, { direction: { attachments: true } as never, ...settings });
  const ctx: CronContext = {
    ...base,
    client: fake.client as never,
    storage: {
      async download() {
        return PNG;
      },
      async upload(path) {
        uploads.push(path);
        return { error: null };
      },
      async remove() {},
      publicUrl: (p: string) => `https://s/${p}`,
    },
  };
  return { store, fake, ctx, uploads };
}

describe("processJob: the phase 3 kinds", () => {
  it("push_fields pushes the changed custom fields", async () => {
    const { store, fake, ctx } = setup({
      getEditMeta: async () => ({ fields: { customfield_1: { name: "Browser", required: false, operations: ["set"], schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" } } } }),
    });
    store.tickets[0].custom_fields = { fd: "Safari" };
    store.fieldDefs = [{ id: "fd", label: "Browser", field_type: "text", options: [] }];
    store.fieldMappings = [{ id: "m", account_id: "acct-1", connection_id: "conn-1", project_key: "ENG", ticket_field_id: "fd", jira_field_id: "customfield_1", jira_field_name: "Browser", jira_kind: "text", direction: "to_jira", when_missing: "skip", default_value: null, config: null } as FieldMappingRow];
    await processJob(ctx, { kind: "push_fields", payload: { ticket_id: "t-1" } });
    expect(fake.calls.find((c) => c.method === "updateIssue")?.args).toEqual(["10001", { fields: { customfield_1: "Safari" } }]);
    await processJob(ctx, { kind: "push_fields", payload: {} }); // malformed: ignored
    expect(fake.calls.filter((c) => c.method === "updateIssue")).toHaveLength(1);
  });

  it("push_attachment sends the file (an auto one needs 'send all new attachments')", async () => {
    const s = setup();
    s.store.ticketAttachments.push({ id: "att-1", ticket_id: "t-1", account_id: "acct-1", storage_path: "account-acct-1/tickets/1-a.png", url: "u", filename: "a.png", mime_type: "image/png", size_bytes: 9 });
    await processJob(s.ctx, { kind: "push_attachment", payload: { attachment_id: "att-1", auto: true } });
    expect(s.fake.calls.filter((c) => c.method === "uploadAttachment")).toHaveLength(0);
    expect(s.store.events.find((e) => e.kind === "attachment_not_sent")).toMatchObject({ message: "ENG-1: toggle_off" });

    const auto = setup({}, { direction: { attachments: true, attachments_auto: true } as never });
    auto.store.ticketAttachments.push({ id: "att-1", ticket_id: "t-1", account_id: "acct-1", storage_path: "account-acct-1/tickets/1-a.png", url: "u", filename: "a.png", mime_type: "image/png", size_bytes: 9 });
    await processJob(auto.ctx, { kind: "push_attachment", payload: { attachment_id: "att-1", auto: true } });
    expect(auto.fake.calls.filter((c) => c.method === "uploadAttachment")).toHaveLength(1);
  });

  it("pull_attachments downloads new files and queues a follow-up when there are more than one run takes", async () => {
    const list = Array.from({ length: 7 }, (_, i) => ({ id: String(100 + i), filename: `p${i}.png`, mimeType: "image/png", size: 9, created: "2026-09-20T09:30:00.000+0000" }));
    const s = setup({
      getIssue: async () => {
        const i = issue({});
        i.fields.attachment = list;
        return i;
      },
      downloadAttachment: async (id) => ({ ok: true, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, Number(id)]), contentType: "image/png" }),
    });
    s.store.links[0].created_at = "2026-09-20T09:00:00.000Z";
    await processJob(s.ctx, { kind: "pull_attachments", payload: { link_id: "L1" } });
    expect(s.store.ticketAttachments.filter((a) => a.source === "jira")).toHaveLength(5);
    expect(s.store.jobs).toEqual([expect.objectContaining({ kind: "pull_attachments", dedupe: "pullatt:L1", payload: { link_id: "L1" } })]);
    await processJob(s.ctx, { kind: "pull_attachments", payload: { link_id: "L1" } });
    expect(s.store.ticketAttachments.filter((a) => a.source === "jira")).toHaveLength(7);
    expect(s.store.jobs).toHaveLength(1); // no third job
  });

  it("pull_attachments leaves a paused link alone", async () => {
    const s = setup();
    s.store.links[0].sync_state = "paused";
    await processJob(s.ctx, { kind: "pull_attachments", payload: { link_id: "L1" } });
    expect(s.fake.calls).toEqual([]);
  });

  it("without the storage client the attachment jobs fail loudly (the queue retries), never silently", async () => {
    const s = setup();
    const noStorage = { ...s.ctx, storage: undefined };
    await expect(processJob(noStorage, { kind: "pull_attachments", payload: { link_id: "L1" } })).rejects.toThrow(/storage/);
    await expect(processJob(noStorage, { kind: "push_attachment", payload: { attachment_id: "x" } })).rejects.toThrow(/storage/);
  });

  it("bulk_item runs one item of a batch", async () => {
    const s = setup({ createIssue: async () => ({ id: "20001", key: "ENG-101" }), getIssue: async () => issue({ id: "20001", key: "ENG-101" }), listCreateFields: async () => ({ fields: [] }) });
    s.store.links.length = 0;
    const { batch, items } = await s.store.createBulkBatch({ accountId: "acct-1", connectionId: "conn-1", kind: "create", createdBy: "user-agent", items: [{ ticketId: "t-1", projectKey: "ENG", issueTypeId: "10004" }] });
    await processJob(s.ctx, { kind: "bulk_item", payload: { batch_id: batch.id, item_id: items[0].id, user_id: "user-agent" } });
    expect(s.store.bulkItems[0]).toMatchObject({ status: "done", issue_key: "ENG-101" });
  });
});
