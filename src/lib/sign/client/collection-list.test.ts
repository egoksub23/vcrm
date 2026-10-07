import { describe, expect, it } from "vitest";

import { MAX_COLLECTION_BYTES, addFiles, collectionRequest, defaultTitle, hasTemplate, moveBy, moveTo, orderPayload, removeItem, retitle, shownTitle, sizeOk, toggleTemplate, type CollectionItem, type FileLike } from "./collection-list";

const f = (name: string, size = 1000): FileLike => ({ name, size });
const names = (items: readonly CollectionItem<FileLike>[]) => items.map((i) => (i.kind === "file" ? i.file.name : i.name));
const mk = (...list: string[]) => addFiles<FileLike>([], list.map((n) => f(n))).items;

describe("adding files", () => {
  it("adds many at once, in the order chosen, with no title of their own", () => {
    const r = addFiles<FileLike>([], [f("a.pdf"), f("b.docx"), f("c.png")]);
    expect(names(r.items)).toEqual(["a.pdf", "b.docx", "c.png"]);
    expect(r).toMatchObject({ added: 3, rejected: [], overflow: 0 });
    expect(r.items.every((i) => i.title === "")).toBe(true);
    expect(new Set(r.items.map((i) => i.key)).size).toBe(3);
  });

  it("adds one by one later, after what is there", () => {
    const first = addFiles<FileLike>([], [f("a.pdf")]);
    const second = addFiles(first.items, [f("b.pdf")]);
    expect(names(second.items)).toEqual(["a.pdf", "b.pdf"]);
    // and the earlier list is not changed
    expect(names(first.items)).toEqual(["a.pdf"]);
  });

  it("names a file that cannot be used and leaves it out: a wrong type, empty, over 25 MB", () => {
    const r = addFiles<FileLike>([], [f("a.pdf"), f("notes.txt"), f("empty.pdf", 0), f("huge.pdf", 26 * 1024 * 1024), f("b.JPG")]);
    expect(names(r.items)).toEqual(["a.pdf", "b.JPG"]);
    expect(r.rejected).toEqual([
      { name: "notes.txt", code: "upload_unsupported" },
      { name: "empty.pdf", code: "upload_empty" },
      { name: "huge.pdf", code: "upload_too_large" },
    ]);
  });

  it("adds what fits when more are chosen than there is room for, and counts the rest", () => {
    const start = mk("1.pdf", "2.pdf", "3.pdf", "4.pdf");
    const r = addFiles(start, [f("5.pdf"), f("6.pdf"), f("7.pdf"), f("8.pdf")]);
    expect(names(r.items)).toEqual(["1.pdf", "2.pdf", "3.pdf", "4.pdf", "5.pdf", "6.pdf"]);
    expect(r).toMatchObject({ added: 2, overflow: 2, rejected: [] });
    expect(addFiles(r.items, [f("9.pdf")])).toMatchObject({ added: 0, overflow: 1 });
  });

  it("holds a smaller number when the room is smaller (adding to a collection that already has documents)", () => {
    const r = addFiles<FileLike>([], [f("a.pdf"), f("b.pdf"), f("c.pdf")], 2);
    expect(names(r.items)).toEqual(["a.pdf", "b.pdf"]);
    expect(r.overflow).toBe(1);
  });

  it("does not count a file that cannot be used as one that did not fit", () => {
    const r = addFiles<FileLike>(mk("1.pdf", "2.pdf", "3.pdf", "4.pdf", "5.pdf"), [f("bad.txt"), f("6.pdf"), f("7.pdf")]);
    expect(r).toMatchObject({ added: 1, overflow: 1, rejected: [{ name: "bad.txt", code: "upload_unsupported" }] });
  });

  it("keeps the files of one request within 60 MB in all", () => {
    const mb = 1024 * 1024;
    const r = addFiles<FileLike>([], [f("a.pdf", 24 * mb), f("b.pdf", 24 * mb), f("c.pdf", 24 * mb), f("d.pdf", 24 * mb)]);
    expect(names(r.items)).toEqual(["a.pdf", "b.pdf"]);
    expect(r.rejected.map((x) => [x.name, x.code])).toEqual([["c.pdf", "uploads_too_large"], ["d.pdf", "uploads_too_large"]]);
    expect(MAX_COLLECTION_BYTES).toBe(60 * mb);
  });
});

describe("templates in the same list", () => {
  it("ticks a template onto the end, and ticking it again takes it out", () => {
    const withFile = mk("a.pdf");
    const on = toggleTemplate(withFile, { id: "t1", name: "Merchant Agreement" });
    expect(names(on.items)).toEqual(["a.pdf", "Merchant Agreement"]);
    expect(hasTemplate(on.items, "t1")).toBe(true);
    const off = toggleTemplate(on.items, { id: "t1", name: "Merchant Agreement" });
    expect(names(off.items)).toEqual(["a.pdf"]);
    expect(off.full).toBe(false);
  });

  it("adds nothing when the list is full, and says so", () => {
    const full = mk("1.pdf", "2.pdf", "3.pdf", "4.pdf", "5.pdf", "6.pdf");
    const r = toggleTemplate(full, { id: "t1", name: "T" });
    expect(r.full).toBe(true);
    expect(r.items).toHaveLength(6);
    // an already ticked template can still be unticked when full
    const fiveAndT = toggleTemplate(mk("1.pdf", "2.pdf", "3.pdf", "4.pdf", "5.pdf"), { id: "t1", name: "T" }).items;
    expect(toggleTemplate(fiveAndT, { id: "t1", name: "T" }).items).toHaveLength(5);
  });
});

describe("reordering, removing, renaming", () => {
  it("moves up and down, and stops at the ends", () => {
    expect(moveBy(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveBy(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveBy(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveBy(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });

  it("moves an item to a place (drag and drop), clamped, as a copy", () => {
    const list = ["a", "b", "c", "d"];
    expect(moveTo(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveTo(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveTo(list, 1, 99)).toEqual(["a", "c", "d", "b"]);
    expect(moveTo(list, 9, 0)).toEqual(list);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });

  it("removes by key, from the middle too, and the rest keep their order", () => {
    const items = mk("a.pdf", "b.pdf", "c.pdf");
    expect(names(removeItem(items, items[1].key))).toEqual(["a.pdf", "c.pdf"]);
  });

  it("names a document by the sender's title, else the file name without its extension, else the template's name", () => {
    const items = toggleTemplate(mk("Contract v2.pdf"), { id: "t1", name: "Fee Schedule" }).items;
    expect(items.map(defaultTitle)).toEqual(["Contract v2", "Fee Schedule"]);
    const renamed = retitle(items, items[0].key, "  Main contract ");
    expect(shownTitle(renamed[0])).toBe("Main contract");
    expect(shownTitle(retitle(renamed, items[0].key, "   ")[0])).toBe("Contract v2");
  });

  it("is ready at two to six", () => {
    expect([0, 1, 2, 6, 7].map(sizeOk)).toEqual([false, false, true, true, false]);
  });
});

describe("the request that makes the documents", () => {
  const file = (name: string) => new File(["x"], name);
  const build = (): CollectionItem<File>[] => {
    let items = addFiles<File>([], [file("a.pdf")]).items;
    items = toggleTemplate(items, { id: "t1", name: "Agreement" }).items;
    items = addFiles(items, [file("b.pdf"), file("c.pdf")]).items;
    items = toggleTemplate(items, { id: "t2", name: "Fees" }).items;
    return items;
  };

  it("numbers the files in the order they appear and names the templates by id, in one order", () => {
    const { order, files } = orderPayload(build());
    expect(files.map((x) => x.name)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    expect(order).toEqual([
      { kind: "file", index: 0 },
      { kind: "template", id: "t1" },
      { kind: "file", index: 1 },
      { kind: "file", index: 2 },
      { kind: "template", id: "t2" },
    ]);
  });

  it("follows a reorder: the file indexes follow the new order, and a title the sender typed goes with its document", () => {
    let items = build();
    items = retitle(items, items[2].key, " Annex ");
    items = moveTo(items, 2, 0);
    const { order, files } = orderPayload(items);
    expect(files.map((x) => x.name)).toEqual(["b.pdf", "a.pdf", "c.pdf"]);
    expect(order.slice(0, 3)).toEqual([{ kind: "file", index: 0, title: "Annex" }, { kind: "file", index: 1 }, { kind: "template", id: "t1" }]);
  });

  it("is multipart when there is a file: every file as a file part, then the order and the fields, and no empty field", async () => {
    const req = collectionRequest(build(), { title: "Onboarding", contactId: "c1", ticketId: null, dealId: "" });
    expect("form" in req).toBe(true);
    const form = (req as { form: FormData }).form;
    expect(form.getAll("file").map((x) => (x as File).name)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    expect(JSON.parse(form.get("order") as string)).toHaveLength(5);
    expect([form.get("title"), form.get("contactId"), form.has("ticketId"), form.has("dealId")]).toEqual(["Onboarding", "c1", false, false]);
  });

  it("carries the choice to keep the documents private (migration 176), only when it is made", () => {
    const form = (collectionRequest(build(), { title: "Onboarding", isPrivate: "true" }) as { form: FormData }).form;
    expect(form.get("isPrivate")).toBe("true");
    expect((collectionRequest(build(), { title: "Onboarding", isPrivate: null }) as { form: FormData }).form.has("isPrivate")).toBe(false);
    const items = toggleTemplate(toggleTemplate<File>([], { id: "t1", name: "A" }).items, { id: "t2", name: "B" }).items;
    expect(collectionRequest(items, { isPrivate: "true" })).toMatchObject({ json: { isPrivate: "true" } });
  });

  it("is JSON when there are only templates", () => {
    const items = toggleTemplate(toggleTemplate<File>([], { id: "t1", name: "A" }).items, { id: "t2", name: "B" }).items;
    expect(collectionRequest(items, { title: "" })).toEqual({ json: { order: [{ kind: "template", id: "t1" }, { kind: "template", id: "t2" }] } });
  });
});
