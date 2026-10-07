import { describe, expect, it } from "vitest";

import { MAX_UPLOAD_FILES, readUploads } from "./http";
import { readCollectionRequest } from "./service/envelope-request";

// Several files in one request (a document collection): the limits per file and in all, the order, and the old single-file request.

const URL_ = "https://halo.test/api/sign/envelopes";
const TPL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TPL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const png = (name: string, bytes = 3) => new File([new Uint8Array(bytes).fill(7)], name, { type: "image/png" });
function multipart(parts: [string, string | File][]): Request {
  const form = new FormData();
  for (const [k, v] of parts) {
    if (typeof v === "string") form.append(k, v);
    else form.append(k, v, v.name);
  }
  return new Request(URL_, { method: "POST", body: form });
}

describe("readUploads", () => {
  it("reads every file part in the order they were sent, with the text fields", async () => {
    const { files, fields } = await readUploads(multipart([["title", "Pack"], ["file", png("a.png", 1)], ["order", "[]"], ["file", png("b.png", 2)], ["file", png("c.png", 3)]]));
    expect(files.map((f) => [f.name, f.bytes.byteLength])).toEqual([["a.png", 1], ["b.png", 2], ["c.png", 3]]);
    expect(fields).toEqual({ title: "Pack", order: "[]" });
  });

  it("ignores a file part that is not named file, and reads a request with no file as no files", async () => {
    expect((await readUploads(multipart([["other", png("x.png")], ["file", png("a.png")]]))).files.map((f) => f.name)).toEqual(["a.png"]);
    expect((await readUploads(multipart([["title", "Only text"]]))).files).toEqual([]);
  });

  it("refuses more files than the limit, before using any of them", async () => {
    const parts: [string, File][] = Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, i) => ["file", png(`${i}.png`)]);
    await expect(readUploads(multipart(parts))).rejects.toMatchObject({ code: "too_many_files", status: 400 });
    await expect(readUploads(multipart(parts.slice(0, MAX_UPLOAD_FILES)))).resolves.toMatchObject({ files: expect.any(Array) });
    await expect(readUploads(multipart(parts.slice(0, 3)), { maxFiles: 2 })).rejects.toMatchObject({ code: "too_many_files" });
  });

  it("refuses a file over the size of one file, naming it as a file (413)", async () => {
    await expect(readUploads(multipart([["file", png("big.png", 600)], ["file", png("small.png", 5)]]), { maxFileBytes: 500 })).rejects.toMatchObject({ code: "upload_too_large", status: 413 });
  });

  it("refuses a body over the total, declared or not, and reads no more than the total", async () => {
    // declared: refused at once
    const declared = new Request(URL_, { method: "POST", body: "x", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "5000" } });
    await expect(readUploads(declared, { maxBytes: 1000 })).rejects.toMatchObject({ code: "uploads_too_large", status: 413 });
    // sent chunked with no length, or with a length that lies: the stream is read only until it passes the cap
    let pulled = 0;
    const piece = new Uint8Array(400);
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull: (c) => {
          pulled += piece.byteLength;
          c.enqueue(piece);
        },
      });
    for (const headers of [{ "content-type": "multipart/form-data; boundary=x" }, { "content-type": "multipart/form-data; boundary=x", "content-length": "100" }]) {
      pulled = 0;
      const req = new Request(URL_, { method: "POST", body: endless(), headers, duplex: "half" } as RequestInit);
      await expect(readUploads(req, { maxBytes: 1000 })).rejects.toMatchObject({ code: "uploads_too_large", status: 413 });
      expect(pulled).toBeLessThanOrEqual(1000 + 2 * piece.byteLength + 1024);
    }
  });

  it("answers 400 for a body that is not a multipart upload", async () => {
    await expect(readUploads(new Request(URL_, { method: "POST", body: "nope", headers: { "content-type": "multipart/form-data; boundary=zzz" } }))).rejects.toMatchObject({ code: "bad_upload", status: 400 });
  });
});

describe("readCollectionRequest", () => {
  it("reads several files with an order that interleaves them with templates", async () => {
    const order = [{ kind: "template", id: TPL_A }, { kind: "file", index: 1, title: "Second" }, { kind: "file", index: 0 }];
    const r = await readCollectionRequest(multipart([["file", png("a.png")], ["file", png("b.png")], ["order", JSON.stringify(order)], ["title", "Pack"]]));
    expect(r.uploads.map((u) => u.filename)).toEqual(["a.png", "b.png"]);
    expect(r.order).toEqual(order);
    expect(r.data.title).toBe("Pack");
  });

  it("keeps the old request working: one file and templateIds, no order", async () => {
    const r = await readCollectionRequest(multipart([["file", png("cover.png")], ["templateIds", JSON.stringify([TPL_A, TPL_B])]]));
    expect(r.uploads).toHaveLength(1);
    expect(r.templateIds).toEqual([TPL_A, TPL_B]);
    expect(r.order).toBeUndefined();
  });

  it("reads a JSON body of templates, with templateIds or with an order", async () => {
    const json = (body: unknown) => new Request(URL_, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    expect(await readCollectionRequest(json({ templateIds: [TPL_A, TPL_B], title: "T" }))).toMatchObject({ uploads: [], templateIds: [TPL_A, TPL_B], order: undefined, data: { title: "T" } });
    expect((await readCollectionRequest(json({ order: [{ kind: "template", id: TPL_B }, { kind: "template", id: TPL_A }] }))).order).toEqual([{ kind: "template", id: TPL_B }, { kind: "template", id: TPL_A }]);
  });

  it("refuses an order that is not sound: an unknown file, a file left out, a template twice, more than six, and nonsense", async () => {
    const bad = async (parts: [string, string | File][]) => readCollectionRequest(multipart(parts));
    await expect(bad([["file", png("a.png")], ["order", JSON.stringify([{ kind: "file", index: 3 }])]])).rejects.toMatchObject({ code: "bad_order", status: 400 });
    await expect(bad([["file", png("a.png")], ["file", png("b.png")], ["order", JSON.stringify([{ kind: "file", index: 0 }, { kind: "template", id: TPL_A }])]])).rejects.toMatchObject({ code: "bad_order" });
    await expect(bad([["file", png("a.png")], ["order", JSON.stringify([{ kind: "file", index: 0 }, { kind: "template", id: TPL_A }, { kind: "template", id: TPL_A }])]])).rejects.toMatchObject({ code: "envelope_duplicate_template" });
    await expect(bad([["order", JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ kind: "template", id: `${i}0000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa` })))]])).rejects.toMatchObject({ code: "envelope_size" });
    await expect(bad([["order", "not json"]])).rejects.toMatchObject({ code: "bad_order" });
    await expect(bad([["order", JSON.stringify([{ kind: "folder" }])]])).rejects.toMatchObject({ code: "bad_order" });
    await expect(bad([["order", JSON.stringify([{ kind: "template", id: "not-an-id" }])]])).rejects.toMatchObject({ code: "bad_order" });
    await expect(bad([["templateIds", JSON.stringify(["nope"])]])).rejects.toMatchObject({ code: "template_required" });
  });

  it("refuses a wrong type of file at the service (the same check a document alone gets), not here", async () => {
    // reading never judges the type: a text file is read like any other, and `createEnvelopeDraft` refuses it as upload_unsupported
    const r = await readCollectionRequest(multipart([["file", new File(["hello"], "notes.txt", { type: "text/plain" })], ["file", png("a.png")]]));
    expect(r.uploads.map((u) => u.filename)).toEqual(["notes.txt", "a.png"]);
  });
});
