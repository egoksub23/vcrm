import { describe, expect, it } from "vitest";

import type { PlacedField } from "../pdf/types";
import type { DataField, FormDefinition, L10n, PartProgress, SignerFormView } from "../forms/types";
import { SignApiError } from "./api";
import { failureFrom } from "./signer-api";
import {
  PROBLEM_CODES,
  acceptAttribute,
  acceptedKinds,
  acceptsPictures,
  checkFormInput,
  effectiveAnswers,
  firstUnfinished,
  fileProblem,
  fitTargets,
  formStateFromView,
  formViewOf,
  formatBytes,
  inputFromView,
  invalidDrafts,
  latestSaved,
  mapFormIssues,
  mergeFormView,
  needsWork,
  partAfter,
  partRows,
  partsLeft,
  printedPreviews,
  problemKey,
  requiredLeft,
  reviewGate,
  rowStatus,
  savedAgo,
  showWhileTyping,
  toAnswerMap,
  uploadFailure,
  visibleRejections,
  withAnswer,
  withConfirmed,
  withSaved,
  withUpload,
  withoutUpload,
} from "./signer-form";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const L = (en: string): L10n => ({ en });

const definition: FormDefinition = {
  version: 1,
  parts: [
    { key: "company", title: L("Company"), role: "merchant" },
    { key: "tax", title: L("Tax"), role: "merchant" },
    { key: "docs", title: L("Documents"), role: "merchant" },
    { key: "extra", title: L("Extra"), role: "merchant", visibleIf: { op: "eq", field: "bizType", value: "sdn_bhd" } },
    { key: "bank", title: L("Bank"), role: "finance" },
  ],
  fields: [
    { key: "legalName", type: "text", part: "company", label: L("Legal name"), required: true },
    { key: "bizType", type: "choice", part: "company", label: L("Type"), required: true, options: [{ value: "sdn_bhd", label: L("Sdn. Bhd.") }, { value: "sole", label: L("Sole proprietor") }] },
    { key: "email", type: "email", part: "company", label: L("Email"), required: false },
    { key: "taxType", type: "choice", part: "tax", label: L("Tax type"), required: false, options: [{ value: "sst", label: L("SST") }, { value: "na", label: L("None") }] },
    { key: "taxPct", type: "number", part: "tax", label: L("Tax %"), required: false, requiredIf: { op: "eq", field: "taxType", value: "sst" }, visibleIf: { op: "eq", field: "taxType", value: "sst" }, min: 0, max: 100 },
    { key: "msic", type: "list", part: "tax", label: L("MSIC"), required: true, itemFormat: "digits", itemLength: 5, maxItems: 3 },
    { key: "form9", type: "file", part: "docs", label: L("Form 9"), required: true, accept: ["pdf", "jpg"], maxMb: 2, maxFiles: 2 },
    { key: "stamp", type: "image", part: "docs", label: L("Stamp"), required: false },
    { key: "note", type: "text", part: "extra", label: L("Note"), required: true },
    { key: "account", type: "text", part: "bank", label: L("Account"), required: true },
  ],
};

const file = (id: string, name = `${id}.pdf`) => ({ id, name, mime: "application/pdf", size: 1000, sha256: "x" });

function view(over: Partial<SignerFormView> = {}): SignerFormView {
  return { definition, partKeys: ["company", "tax", "docs", "extra"], answers: {}, unconfirmed: [], progress: [], ready: false, ...over };
}

describe("the form as the page holds it", () => {
  it("round trips, and drops what was cleared", () => {
    const state = formStateFromView(view({ answers: { legalName: { text: "Kedai" } } }));
    expect(formViewOf(state).answers).toEqual({ legalName: { text: "Kedai" } });
    expect(formViewOf(withAnswer(state, "legalName", null)).answers).toEqual({});
  });

  it("keeps what was entered here over what the server last said, and does not bring back what was cleared", () => {
    const local = withAnswer(withAnswer(formStateFromView(view()), "legalName", { text: "Mine" }), "email", null);
    const merged = mergeFormView(local, view({ answers: { legalName: { text: "Theirs" }, email: { text: "a@b.co" }, taxType: { text: "sst" } }, ready: true }));
    expect(formViewOf(merged).answers).toEqual({ legalName: { text: "Mine" }, taxType: { text: "sst" } });
    expect(merged.ready).toBe(true);
  });

  it("starts from the server when there is nothing yet, and treats a changed answer as no longer from the records", () => {
    const first = mergeFormView(null, view({ unconfirmed: ["legalName", "email"] }));
    expect(first.unconfirmed).toEqual(["legalName", "email"]);
    expect(withAnswer(first, "legalName", { text: "x" }).unconfirmed).toEqual(["email"]);
    const again = mergeFormView(withAnswer(first, "legalName", { text: "x" }), view({ unconfirmed: ["legalName", "email"] }));
    expect(again.unconfirmed).toEqual(["email"]);
  });

  it("takes progress, readiness and unconfirmed answers from a save", () => {
    const progress: PartProgress[] = [{ key: "company", state: "done", done: 2, total: 2, visible: 3, lastSavedAt: "2026-10-06T10:00:00Z" }];
    const state = withSaved(formStateFromView(view({ unconfirmed: ["email"] })), { progress, ready: true, unconfirmed: [] });
    expect(state.progress).toBe(progress);
    expect(state.ready).toBe(true);
    expect(state.unconfirmed).toEqual([]);
    // a save that says nothing about them leaves them be
    expect(withSaved(state, {}).progress).toBe(progress);
  });

  it("adds an uploaded file, replaces the same one, and removes one", () => {
    const base = formStateFromView(view());
    const added = withUpload(base, "form9", file("a"), { progress: [], ready: false });
    const two = withUpload(added, "form9", file("b"), { progress: [], ready: true });
    expect(formViewOf(two).answers.form9).toEqual({ files: [file("a"), file("b")] });
    expect(two.ready).toBe(true);
    expect(formViewOf(withUpload(two, "form9", { ...file("b"), name: "again.pdf" }, { progress: [], ready: true })).answers.form9).toEqual({ files: [file("a"), { ...file("b"), name: "again.pdf" }] });
    const less = withoutUpload(two, "form9", "a", { progress: [], ready: false });
    expect(formViewOf(less).answers.form9).toEqual({ files: [file("b")] });
    expect(formViewOf(withoutUpload(less, "form9", "b", { progress: [], ready: false })).answers.form9).toBeUndefined();
  });

  it("confirms every answer of a part", () => {
    const state = withConfirmed(formStateFromView(view({ unconfirmed: ["legalName", "email", "taxType"] })), "company");
    expect(state.unconfirmed).toEqual(["taxType"]);
  });
});

describe("what is typed and what is held", () => {
  it("reads stored answers back into what a control shows", () => {
    expect(inputFromView({ text: "a" })).toEqual({ text: "a" });
    expect(inputFromView({ checked: true })).toEqual({ checked: true });
    expect(inputFromView({ choices: ["x"] })).toEqual({ choices: ["x"] });
    expect(inputFromView({ list: ["1"] })).toEqual({ list: ["1"] });
    expect(inputFromView({ image: PNG, mime: "image/png" })).toEqual({ image: PNG });
    expect(inputFromView({ files: [file("a")] })).toEqual({});
    expect(inputFromView(undefined)).toEqual({});
  });

  it("checks a picture without Node's Buffer, and everything else with the shared check", () => {
    const stamp = definition.fields.find((f) => f.key === "stamp") as DataField;
    expect(checkFormInput(stamp, { image: PNG })).toEqual({ ok: true, value: { image: PNG, mime: "image/png" } });
    expect(checkFormInput(stamp, { image: "data:image/png;base64,AAAA" })).toEqual({ ok: false, code: "bad_image" });
    expect(checkFormInput(stamp, { image: "" })).toEqual({ ok: true, value: null });
    const email = definition.fields.find((f) => f.key === "email") as DataField;
    expect(checkFormInput(email, { text: "A@B.CO" })).toEqual({ ok: true, value: { text: "a@b.co" } });
    expect(checkFormInput(email, { text: "nope" })).toMatchObject({ ok: false, code: "bad_email" });
  });

  it("shows a condition at once from what is typed, but only from what is acceptable", () => {
    const stored = { taxType: { text: "na" } } as const;
    // typing "sst" into the choice makes the tax percentage appear before anything is saved
    const typed = effectiveAnswers(definition, stored, { taxType: { text: "sst" } });
    expect(typed.taxType).toEqual({ text: "sst" });
    // an answer that is not a real option changes nothing
    expect(effectiveAnswers(definition, stored, { taxType: { text: "zzz" } }).taxType).toEqual({ text: "na" });
    // clearing removes the answer
    expect(effectiveAnswers(definition, stored, { taxType: { text: "" } }).taxType).toBeUndefined();
    // a file is never typed
    expect(effectiveAnswers(definition, { form9: { files: [file("a")] } }, { form9: { text: "x" } }).form9).toEqual({ files: [{ ...file("a"), path: "" }] });
  });

  it("names the drafts that are not acceptable, for fields that are shown", () => {
    const answers = effectiveAnswers(definition, {}, {});
    expect(invalidDrafts(definition, answers, { email: { text: "nope" }, taxPct: { text: "999" }, legalName: { text: "ok" } })).toEqual({ email: { code: "bad_email", detail: undefined } });
    const sst = effectiveAnswers(definition, {}, { taxType: { text: "sst" } });
    expect(invalidDrafts(definition, sst, { taxType: { text: "sst" }, taxPct: { text: "999" } }).taxPct?.code).toBe("number_too_big");
  });

  it("holds files for the rules without the server's path", () => {
    const map = toAnswerMap({ form9: { files: [file("a")] }, gone: null, text: { text: "x" } });
    expect(map.form9).toEqual({ files: [{ ...file("a"), path: "" }] });
    expect(map.gone).toBeUndefined();
  });
});

describe("the overview", () => {
  const progress: PartProgress[] = [{ key: "company", state: "in_progress", done: 1, total: 2, visible: 3, lastSavedAt: "2026-10-06T09:00:00Z" }];

  it("lists the parts that are shown, in order, numbered, with where each stands", () => {
    const answers = toAnswerMap({ legalName: { text: "Kedai" } });
    const rows = partRows(definition, ["company", "tax", "docs", "extra"], answers, progress);
    // "extra" is hidden until the company type is Sdn. Bhd.
    expect(rows.map((r) => [r.part.key, r.number, r.state, r.done, r.total])).toEqual([
      ["company", 1, "in_progress", 1, 2],
      ["tax", 2, "not_started", 0, 1],
      ["docs", 3, "not_started", 0, 1],
    ]);
    expect(rows[0].lastSavedAt).toBe("2026-10-06T09:00:00Z");
    const sdn = partRows(definition, ["company", "tax", "docs", "extra"], toAnswerMap({ bizType: { text: "sdn_bhd" } }), []);
    expect(sdn.map((r) => r.part.key)).toEqual(["company", "tax", "docs", "extra"]);
    expect(sdn[3].number).toBe(4);
  });

  it("goes on to the first part that still has required answers, and counts what is left", () => {
    const done = toAnswerMap({ legalName: { text: "K" }, bizType: { text: "sole" } });
    const rows = partRows(definition, ["company", "tax", "docs"], done, []);
    expect(rows[0].state).toBe("done");
    expect(firstUnfinished(rows)?.part.key).toBe("tax");
    expect(partsLeft(rows)).toBe(2);
    expect(partAfter(rows, "company")?.part.key).toBe("tax");
    expect(partAfter(rows, "docs")).toBeUndefined();
    expect(partAfter(rows, "nope")).toBeUndefined();
    expect(needsWork(rows[0])).toBe(false);
    expect(requiredLeft(rows[1])).toBe(1);
    const all = toAnswerMap({ legalName: { text: "K" }, bizType: { text: "sole" }, msic: { list: ["47111"] }, form9: { files: [file("a")] } });
    const finished = partRows(definition, ["company", "tax", "docs"], all, []);
    expect(firstUnfinished(finished)).toBeUndefined();
    expect(partsLeft(finished)).toBe(0);
  });

  it("marks a part that has an answer typed but not acceptable", () => {
    const rows = partRows(definition, ["company"], toAnswerMap({ legalName: { text: "K" }, bizType: { text: "sole" } }), [], new Set(["email"]));
    expect(rows[0].needsChange).toBe(true);
    expect(rowStatus(rows[0])).toBe("needs_change");
    expect(rowStatus({ ...rows[0], needsChange: false })).toBe("done");
  });

  it("finds when the last save was, and says how long ago in numbers", () => {
    expect(latestSaved([{ key: "a", state: "done", done: 0, total: 0, visible: 0, lastSavedAt: "2026-10-06T08:00:00Z" }, { key: "b", state: "done", done: 0, total: 0, visible: 0, lastSavedAt: "2026-10-06T09:30:00Z" }, { key: "c", state: "done", done: 0, total: 0, visible: 0, lastSavedAt: null }])).toBe("2026-10-06T09:30:00Z");
    expect(latestSaved([])).toBeNull();
    const at = "2026-10-06T10:00:00Z";
    const now = Date.parse(at);
    expect(savedAgo(at, now + 10_000)).toEqual({ kind: "now" });
    expect(savedAgo(at, now + 2 * 60_000)).toEqual({ kind: "ago", value: -2, unit: "minute" });
    expect(savedAgo(at, now + 3 * 3600_000)).toEqual({ kind: "ago", value: -3, unit: "hour" });
    expect(savedAgo(at, now + 50 * 3600_000)).toEqual({ kind: "ago", value: -2, unit: "day" });
    expect(savedAgo(at, now - 5000)).toEqual({ kind: "now" });
    expect(savedAgo(null, now)).toBeNull();
    expect(savedAgo("not a time", now)).toBeNull();
  });
});

describe("a file, before it is sent", () => {
  const field = { accept: ["pdf", "jpg"] as DataField["accept"], maxMb: 2, maxFiles: 2 };
  const pdf = { name: "Form 9.PDF", type: "application/pdf", size: 1000 };

  it("takes the kinds the field names, by name and by type", () => {
    expect(fileProblem(field, pdf, 0)).toBeNull();
    expect(fileProblem(field, { name: "ic.jpeg", type: "image/jpeg", size: 1000 }, 0)).toBeNull();
    // a phone that gives no type is judged by the name
    expect(fileProblem(field, { name: "ic.jpg", type: "", size: 1000 }, 0)).toBeNull();
    expect(fileProblem(field, { name: "ic.png", type: "image/png", size: 1000 }, 0)).toEqual({ code: "file_type" });
    expect(fileProblem(field, { name: "form.pdf", type: "image/png", size: 1000 }, 0)).toEqual({ code: "file_type" });
    expect(fileProblem(field, { name: "form", type: "application/pdf", size: 1000 }, 0)).toEqual({ code: "file_type" });
  });

  it("holds to the size and the count, with the limit to show", () => {
    expect(fileProblem(field, { ...pdf, size: 2 * 1024 * 1024 }, 0)).toBeNull();
    expect(fileProblem(field, { ...pdf, size: 2 * 1024 * 1024 + 1 }, 0)).toEqual({ code: "file_too_large", detail: "2" });
    expect(fileProblem(field, { ...pdf, size: 0 }, 0)).toEqual({ code: "file_empty" });
    expect(fileProblem(field, pdf, 1)).toBeNull();
    expect(fileProblem(field, pdf, 2)).toEqual({ code: "too_many_files", detail: "2" });
    // never more than the module allows, whatever the field says
    expect(fileProblem({ accept: ["pdf"], maxMb: 99 }, { ...pdf, size: 11 * 1024 * 1024 }, 0)).toEqual({ code: "file_too_large", detail: "10" });
    expect(fileProblem({ accept: ["pdf"] }, { ...pdf, size: 6 * 1024 * 1024 }, 0)).toEqual({ code: "file_too_large", detail: "5" });
  });

  it("tells a phone what to offer", () => {
    expect(acceptedKinds({})).toEqual(["pdf", "jpg", "png"]);
    expect(acceptAttribute({ accept: ["pdf", "jpg"] })).toBe(".pdf,application/pdf,.jpg,.jpeg,image/jpeg");
    expect(acceptsPictures({ accept: ["pdf"] })).toBe(false);
    expect(acceptsPictures({ accept: ["pdf", "png"] })).toBe(true);
  });

  it("writes a size a person reads", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.2 * 1024 * 1024)).toBe("1.2 MB");
    expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
  });

  it("turns a failed upload into a code with the field's own limit", () => {
    expect(uploadFailure({ maxMb: 3 }, { code: "file_too_large" })).toEqual({ code: "file_too_large", detail: "3" });
    expect(uploadFailure({ maxFiles: 4 }, { code: "too_many_files" })).toEqual({ code: "too_many_files", detail: "4" });
    expect(uploadFailure({}, { code: "file_type" })).toEqual({ code: "file_type" });
    expect(uploadFailure({}, { code: "network" })).toEqual({ code: "network" });
    // the server's three ways of saying the kind is wrong read as one
    for (const code of ["file_type_not_allowed", "unsupported_file"]) expect(uploadFailure({}, { code })).toEqual({ code: "file_type" });
    expect(uploadFailure({}, { code: "document_upload_limit" })).toEqual({ code: "document_upload_limit" });
    expect(uploadFailure({}, { code: "locked" })).toEqual({ code: "upload_failed" });
    expect(uploadFailure({}, { code: "something_new" })).toEqual({ code: "upload_failed" });
    expect(uploadFailure({}, {})).toEqual({ code: "upload_failed" });
  });

  it("reads a failed upload's answer the way every other call is read", () => {
    const err = failureFrom(400, JSON.stringify({ error: "x", code: "file_type", issues: [{ code: "file_type", field: "form9" }] }));
    expect(err).toBeInstanceOf(SignApiError);
    expect([err.code, err.status, err.issues]).toEqual(["file_type", 400, [{ code: "file_type", field: "form9" }]]);
    expect(failureFrom(413, "<html>too big</html>").code).toBe("file_too_large");
    expect(failureFrom(429, "").code).toBe("rate_limited");
    expect(failureFrom(500, "{").code).toBe("request_failed");
  });
});

describe("the words for a code", () => {
  it("words every code the shared check can give, and reads a list entry's shape like a field's", () => {
    for (const code of ["bad_email", "text_too_long", "format_digits", "format_postcode_my", "not_a_number", "too_many_items", "duplicate_item", "missing_required", "file_type"]) expect(problemKey(code)).toBe(code);
    expect(problemKey("item_format_digits")).toBe("format_digits");
    expect(problemKey("item_format_postcode_my")).toBe("format_postcode_my");
  });

  it("falls back to the general sentence for a code it has never seen", () => {
    expect(problemKey("brand_new")).toBe("generic");
    expect(problemKey("item_format_klingon")).toBe("generic");
    expect(problemKey(null)).toBe("generic");
    expect(PROBLEM_CODES).toContain("generic");
  });

  it("holds back what only means 'not finished' while someone is still typing", () => {
    expect(showWhileTyping("bad_email")).toBe(false);
    expect(showWhileTyping("text_too_short")).toBe(false);
    expect(showWhileTyping("text_too_long")).toBe(true);
    expect(showWhileTyping("format_digits")).toBe(true);
  });
});

describe("what the server answers", () => {
  it("finds the part and field of each answer turned down, in the form's order", () => {
    const t = mapFormIssues(definition, ["company", "tax", "docs"], [
      { code: "missing_required", field: "form9" },
      { code: "bad_email", field: "email" },
      { code: "missing_required", field: "msic" },
      { code: "missing_required", field: "aPlacedField" },
    ]);
    expect(t.rejections).toEqual({ form9: { code: "missing_required", detail: undefined }, email: { code: "bad_email", detail: undefined }, msic: { code: "missing_required", detail: undefined } });
    expect(t.firstPart).toBe("company");
    expect(t.firstField).toBe("email");
    expect(t.fit).toEqual([]);
  });

  it("keeps an answer that is too long for where it prints apart from the rest", () => {
    const t = mapFormIssues(definition, ["company"], [{ code: "answer_does_not_fit", field: "legalName", detail: "p_name" }]);
    expect(t.fit).toEqual([{ field: "legalName", placement: "p_name" }]);
    expect(t.rejections).toEqual({});
    expect(t.firstPart).toBeNull();
  });

  it("marks an answer too long on its field for a person who only fills in, and who has no review step", () => {
    const t = mapFormIssues(definition, ["company", "tax"], [{ code: "answer_does_not_fit", field: "legalName", detail: "p_name" }], true);
    expect(t.rejections).toEqual({ legalName: { code: "answer_does_not_fit" } });
    expect(t.firstPart).toBe("company");
    expect(t.firstField).toBe("legalName");
    expect(t.fit).toEqual([{ field: "legalName", placement: "p_name" }]);
  });

  it("says nothing of a part the signer does not have", () => {
    expect(mapFormIssues(definition, ["company"], [{ code: "missing_required", field: "account" }]).firstPart).toBeNull();
  });

  it("shows a rejection from a save unless the field is no longer shown", () => {
    expect(visibleRejections([{ field: "email", code: "bad_email" }, { field: "note", code: "not_shown" }, { field: "sigField", code: "x" }], definition)).toEqual({ email: { code: "bad_email", detail: undefined } });
    expect(visibleRejections([{ field: "msic", code: "too_many_items", detail: "3" }], definition)).toEqual({ msic: { code: "too_many_items", detail: "3" } });
  });
});

describe("the review step", () => {
  const placements: PlacedField[] = [
    { key: "p_name", type: "text", role: "merchant", page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.04, required: false, data: "legalName" },
    { key: "p_sdn", type: "checkbox", role: "merchant", page: 0, x: 0.1, y: 0.2, w: 0.03, h: 0.02, required: false, data: "bizType", dataValue: "sdn_bhd" },
    { key: "p_stamp", type: "upload", role: "merchant", page: 0, x: 0.5, y: 0.8, w: 0.2, h: 0.1, required: false, data: "stamp" },
    { key: "p_empty", type: "text", role: "merchant", page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.04, required: false, data: "email" },
    { key: "sig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.9, w: 0.3, h: 0.05, required: true },
  ];

  it("draws the printed text and ticks, and the stamp the signer gave, and nothing else", () => {
    const form = { answers: { stamp: { image: PNG, mime: "image/png" as const } } };
    const drawn = printedPreviews(placements, { p_name: { text: "Kedai Runcit Ali" }, p_sdn: { checked: true } }, form);
    expect(drawn.map((d) => [d.field.key, d.input])).toEqual([
      ["p_name", { text: "Kedai Runcit Ali" }],
      ["p_sdn", { checked: true }],
      ["p_stamp", { image: PNG }],
    ]);
    expect(printedPreviews(placements, {}, null)).toEqual([]);
  });

  it("names each answer too long for its place once, with its part", () => {
    const targets = fitTargets(definition, [
      { field: "legalName", placement: "p1" },
      { field: "legalName", placement: "p2" },
      { field: "gone", placement: "p3" },
      { field: "note", placement: "p4" },
    ]);
    expect(targets.map((t) => [t.field.key, t.part])).toEqual([["legalName", "company"], ["note", "extra"]]);
  });

  it("opens signing only when the answers are printed and none is too long", () => {
    expect(reviewGate({ status: "idle" })).toEqual({ canFinish: false, fitCount: 0 });
    expect(reviewGate({ status: "loading" }).canFinish).toBe(false);
    expect(reviewGate({ status: "error" }).canFinish).toBe(false);
    expect(reviewGate({ status: "ready", fitProblems: [] })).toEqual({ canFinish: true, fitCount: 0 });
    expect(reviewGate({ status: "ready", fitProblems: [{ field: "a", placement: "x" }, { field: "a", placement: "y" }, { field: "b", placement: "z" }] })).toEqual({ canFinish: false, fitCount: 2 });
  });
});
