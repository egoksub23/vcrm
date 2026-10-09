import { describe, expect, it } from "vitest";

import { landingFor } from "@/lib/sign/client/blocks-nav";
import { problemBlock, problemTarget } from "@/lib/sign/client/process";
import type { PlacedField } from "@/lib/sign/pdf/types";

import { blockedBy, docFromRow, docIssues, docLocked } from "./use-blocks-data";

// The decisions of step 3 that need no screen: which documents can be changed, what keeps a layout from being saved, and where a Fix button lands.

const field = (key: string, over: Partial<PlacedField> = {}): PlacedField => ({ key, type: "signature", role: "pp_a", page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05, required: true, ...over }) as PlacedField;
const roles = [{ key: "pp_a", label: "Ali", kind: "signer", color: 0, source: "people" }] as never;

describe("a document read for step 3", () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({ title: "Letter", fields_snapshot: [field("a")], roles_snapshot: roles, merge_values: { n: 3, e: null, s: "x" }, page_count: 2, status: "draft", base_path: "p.pdf", template_version_id: null, envelope_id: "e1", form_snapshot: null, mode: "sign", ...over }) as never;

  it("keeps its blocks, roles, values (as text) and pages, and says whether it can have blocks put on it", () => {
    const d = docFromRow(row());
    expect(d).toMatchObject({ title: "Letter", pageCount: 2, isDraft: true, hasFile: true, fromTemplate: false, envelopeId: "e1", formOnly: false, form: null, fileVersion: 0 });
    expect(d.values).toEqual({ n: "3", s: "x" });
    expect(d.fields).toHaveLength(1);
  });

  it("reads a document that was sent, one without a file, one from a template and a form with nothing printed", () => {
    expect(docFromRow(row({ status: "sent" })).isDraft).toBe(false);
    expect(docFromRow(row({ base_path: null })).hasFile).toBe(false);
    expect(docFromRow(row({ template_version_id: "v1" })).fromTemplate).toBe(true);
    expect(docFromRow(row({ mode: "form" })).formOnly).toBe(true);
    // a form without parts is no form
    expect(docFromRow(row({ form_snapshot: { parts: [], fields: [] } })).form).toBeNull();
    expect(docFromRow(row(), 3).fileVersion).toBe(3);
  });
});

describe("when a document's layout is read only", () => {
  const draft = { isDraft: true, fromTemplate: false };
  const on = { phone: false, canSend: true };
  it("is open for a draft the reader may change", () => {
    expect(docLocked(draft, on, false)).toBe(false);
  });
  it("is locked on a phone, without permission, and once the document was sent", () => {
    expect(docLocked(draft, { ...on, phone: true }, false)).toBe(true);
    expect(docLocked(draft, { ...on, canSend: false }, false)).toBe(true);
    expect(docLocked({ ...draft, isDraft: false }, on, false)).toBe(true);
  });
  it("keeps a template's layout locked until the sender unlocks it", () => {
    const tpl = { isDraft: true, fromTemplate: true };
    expect(docLocked(tpl, on, false)).toBe(true);
    expect(docLocked(tpl, on, true)).toBe(false);
  });
});

describe("what keeps a document's blocks from being saved", () => {
  it("is nothing for a sound layout", () => {
    expect(blockedBy({ fields: [field("a")], roles }, 1)).toBe(0);
    expect(docIssues({ fields: [field("a")], roles, form: null }, 1)).toEqual([]);
  });
  it("counts a block on a page the document does not have, and the same one is found when the pages are counted from the file", () => {
    const fields = [field("a", { page: 4 })];
    expect(blockedBy({ fields, roles }, 2)).toBeGreaterThan(0);
    expect(blockedBy({ fields, roles }, 5)).toBe(0);
    expect(docIssues({ fields, roles, form: null }, 2).some((i) => i.field === "a")).toBe(true);
  });
  it("treats a page count of nothing as one page", () => {
    expect(blockedBy({ fields: [field("a")], roles }, 0)).toBe(0);
  });
});

describe("where a Fix button from Review and send lands", () => {
  const ids = ["d1", "d2", "d3"];
  const blocks: Record<string, PlacedField[]> = { d1: [], d2: [field("f1", { page: 1, y: 0.6 })], d3: [] };

  it("names the document and the block, and the editor opens there", () => {
    const issue = { code: "field_outside_page", field: "f1", document: "d2" };
    const target = problemTarget(issue);
    expect(target).toEqual({ step: "blocks", documentId: "d2" });
    const res = landingFor({ doc: target.documentId, block: problemBlock(issue) }, ids, (id) => blocks[id]);
    expect(res).toEqual({ landing: { doc: 1, page: 1, y: 0.6, key: "f1" }, settled: true });
  });

  it("names only the document when the problem is the document's (nobody to sign it): the editor scrolls to it", () => {
    const issue = { code: "document_nobody", document: "d3" };
    const res = landingFor({ doc: problemTarget(issue).documentId, block: problemBlock(issue) }, ids, (id) => blocks[id]);
    expect(res).toEqual({ landing: { doc: 2, page: 0, y: 0, key: null }, settled: true });
  });

  it("lands on the document asked for in ?step=blocks&doc=", () => {
    expect(landingFor({ doc: "d2" }, ids, () => undefined)?.landing.doc).toBe(1);
    expect(landingFor({ doc: null }, ids, () => undefined)).toBeNull();
  });
});
