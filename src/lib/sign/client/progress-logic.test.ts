import { describe, expect, it } from "vitest";

import type { StaffAnswerRow, StaffProgress } from "../forms/api-types";
import type { FormDefinition } from "../forms/types";
import {
  asLocale,
  canExtendExpiry,
  describeAnswer,
  deviceKind,
  extendMinDate,
  extendProblem,
  groupAnswers,
  hasFormParts,
  imageSrc,
  issueViews,
  lastDeviceOf,
  overallStats,
  progressErrorKey,
  roleViews,
  suggestedExpiryDate,
  uploadedFileUrl,
} from "./progress-logic";

const L = (en: string, ms?: string) => ({ en, ...(ms ? { ms } : {}) });

const form: FormDefinition = {
  version: 1,
  parts: [
    { key: "company", title: L("Company and tax", "Syarikat dan cukai"), role: "merchant" },
    { key: "bank", title: L("Bank account"), role: "finance" },
    { key: "docs", title: L("Documents"), role: "merchant" },
  ],
  fields: [
    { key: "legalName", type: "multiline", part: "company", label: L("Legal name"), required: true },
    { key: "bizType", type: "choice", part: "company", label: L("Type", "Jenis"), required: true, options: [{ value: "sdn_bhd", label: L("Sdn. Bhd.", "Sdn. Bhd.") }, { value: "sole", label: L("Sole proprietor", "Pemilik tunggal") }] },
    { key: "msic", type: "list", part: "company", label: L("MSIC codes"), required: true },
    { key: "tax", type: "yesno", part: "company", label: L("Registered for tax"), required: false },
    { key: "terms", type: "acknowledge", part: "company", label: L("Terms"), required: true, text: L("I agree") },
    { key: "branches", type: "multichoice", part: "company", label: L("Branches"), required: false, options: [{ value: "kl", label: L("Kuala Lumpur", "Kuala Lumpur") }, { value: "pj", label: L("Petaling Jaya") }] },
    { key: "account", type: "text", part: "bank", label: L("Account"), required: true },
    { key: "ssm", type: "file", part: "docs", label: L("Form 9"), required: true, accept: ["pdf"] },
    { key: "logo", type: "image", part: "docs", label: L("Signature"), required: false },
  ],
};

const progress = (over: Partial<StaffProgress> = {}): StaffProgress => ({
  form,
  roles: [
    {
      roleKey: "merchant",
      roleLabel: "Merchant",
      signer: { id: "s1", name: "Ali", email: "ali@example.com", status: "viewed" },
      parts: [
        { key: "company", title: L("Company and tax", "Syarikat dan cukai"), state: "in_progress", done: 4, total: 6, visible: 6, lastSavedAt: "2026-10-06T09:12:00Z" },
        { key: "docs", title: L("Documents"), state: "not_started", done: 0, total: 1, visible: 2, lastSavedAt: null },
      ],
      percent: 57,
      lastActivityAt: "2026-10-06T09:12:00Z",
    },
    {
      roleKey: "finance",
      roleLabel: "Finance",
      signer: null,
      parts: [{ key: "bank", title: L("Bank account"), state: "done", done: 1, total: 1, visible: 1, lastSavedAt: "2026-10-05T16:20:00Z" }],
      percent: 100,
      lastActivityAt: null,
    },
  ],
  answers: [],
  lastActivityAt: "2026-10-06T09:12:00Z",
  issues: [],
  ...over,
});

const answer = (over: Partial<StaffAnswerRow> & Pick<StaffAnswerRow, "key" | "type" | "value">): StaffAnswerRow => ({
  part: "company",
  label: L(over.key),
  role: "merchant",
  source: "signer",
  savedAt: "2026-10-06T09:00:00Z",
  ...over,
});

describe("asLocale and hasFormParts", () => {
  it("reads a reader's language as one of the four, and anything else as English", () => {
    expect(asLocale("ms")).toBe("ms");
    expect(asLocale("ko")).toBe("ko");
    expect(asLocale("fr")).toBe("en");
  });
  it("sees a form only when it has a part", () => {
    expect(hasFormParts(null)).toBe(false);
    expect(hasFormParts({ version: 1, parts: [], fields: [] })).toBe(false);
    expect(hasFormParts(form)).toBe(true);
  });
});

describe("roleViews and overallStats", () => {
  it("numbers the parts by their place in the form, words titles in the reader's language and lists the unfinished", () => {
    const [merchant, finance] = roleViews(progress(), "ms");
    expect(merchant.parts.map((p) => [p.number, p.title])).toEqual([
      [1, "Syarikat dan cukai"],
      [3, "Documents"],
    ]);
    expect(merchant.partsDone).toBe(0);
    expect(merchant.unfinished.map((p) => p.title)).toEqual(["Syarikat dan cukai", "Documents"]);
    expect(finance.partsDone).toBe(1);
    expect(finance.unfinished).toEqual([]);
    expect(finance.signer).toBeNull();
  });

  it("keeps a percentage in range", () => {
    const [m] = roleViews(progress({ roles: [{ ...progress().roles[0], percent: 140 }] }), "en");
    expect(m.percent).toBe(100);
    expect(roleViews(progress({ roles: [{ ...progress().roles[0], percent: Number.NaN }] }), "en")[0].percent).toBe(0);
  });

  it("counts parts done and the share of required answers over every role", () => {
    const s = overallStats(progress().roles);
    expect(s.partsTotal).toBe(3);
    expect(s.partsDone).toBe(1);
    expect(s.percent).toBe(Math.round(((4 + 0 + 1) / (6 + 1 + 1)) * 100));
  });
});

describe("deviceKind and lastDeviceOf", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";
  const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";
  const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";
  const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

  it("tells phones, tablets and computers apart, and never guesses", () => {
    expect(deviceKind(IPHONE)).toBe("phone");
    expect(deviceKind(ANDROID)).toBe("phone");
    expect(deviceKind(ANDROID_TABLET)).toBe("tablet");
    expect(deviceKind(IPAD)).toBe("tablet");
    expect(deviceKind(WINDOWS)).toBe("computer");
    expect(deviceKind("Android Chrome")).toBe("phone");
    expect(deviceKind("curl/8.0")).toBeNull();
    expect(deviceKind("")).toBeNull();
    expect(deviceKind(null)).toBeNull();
  });

  it("takes the device of the person's latest action that had one, else the one on their row", () => {
    const events = [
      { signer_id: "s1", actor_type: "signer", device: WINDOWS, doc_seq: 2 },
      { signer_id: "s1", actor_type: "signer", device: IPHONE, doc_seq: 5 },
      { signer_id: "s1", actor_type: "signer", device: null, doc_seq: 6 },
      { signer_id: "s2", actor_type: "signer", device: WINDOWS, doc_seq: 7 },
      { signer_id: "s1", actor_type: "system", device: WINDOWS, doc_seq: 8 },
    ];
    expect(lastDeviceOf("s1", events, null)).toBe("phone");
    expect(lastDeviceOf("s3", events, ANDROID)).toBe("phone");
    expect(lastDeviceOf("s3", events, null)).toBeNull();
    expect(lastDeviceOf(null, events, ANDROID)).toBeNull();
    expect(lastDeviceOf("s1", null, WINDOWS)).toBe("computer");
  });
});

describe("describeAnswer", () => {
  const field = (k: string) => form.fields.find((f) => f.key === k);

  it("shows a choice by its label in the reader's language, falling back to English and then to the stored value", () => {
    expect(describeAnswer("choice", { text: "sole" }, field("bizType"), "ms")).toEqual({ kind: "text", text: "Pemilik tunggal", multiline: false });
    expect(describeAnswer("choice", { text: "sole" }, field("bizType"), "zh")).toEqual({ kind: "text", text: "Sole proprietor", multiline: false });
    expect(describeAnswer("choice", { text: "gone" }, field("bizType"), "en")).toEqual({ kind: "text", text: "gone", multiline: false });
    expect(describeAnswer("choice", { text: "sole" }, undefined, "en")).toEqual({ kind: "text", text: "sole", multiline: false });
  });

  it("shows text as typed, keeping the lines of a multi-line box", () => {
    expect(describeAnswer("text", { text: "Kedai Runcit" }, field("legalName"), "en")).toEqual({ kind: "text", text: "Kedai Runcit", multiline: false });
    expect(describeAnswer("multiline", { text: "Kedai\nRuncit" }, field("legalName"), "en")).toEqual({ kind: "text", text: "Kedai\nRuncit", multiline: true });
    expect(describeAnswer("text", { text: "   " }, field("legalName"), "en")).toEqual({ kind: "empty" });
  });

  it("shows lists and multiple choices one per line", () => {
    expect(describeAnswer("list", { list: ["47111", "", "47211"] }, field("msic"), "en")).toEqual({ kind: "lines", lines: ["47111", "47211"] });
    expect(describeAnswer("multichoice", { choices: ["kl", "pj"] }, field("branches"), "ms")).toEqual({ kind: "lines", lines: ["Kuala Lumpur", "Petaling Jaya"] });
    expect(describeAnswer("list", { list: [] }, field("msic"), "en")).toEqual({ kind: "empty" });
  });

  it("words yes and no in the reader's language, and an accepted text apart", () => {
    expect(describeAnswer("yesno", { checked: true }, field("tax"), "ms")).toEqual({ kind: "text", text: "Ya", multiline: false });
    expect(describeAnswer("yesno", { checked: false }, field("tax"), "ko")).toEqual({ kind: "text", text: "아니요", multiline: false });
    expect(describeAnswer("acknowledge", { checked: true }, field("terms"), "en")).toEqual({ kind: "accepted", checked: true });
  });

  it("lists files by name and size, and shows a picture only from a PNG or JPEG data address", () => {
    const files = [{ id: "f1", name: "form9.pdf", mime: "application/pdf", size: 120_000, sha256: "ab" }];
    expect(describeAnswer("file", { files }, field("ssm"), "en")).toEqual({ kind: "files", files });
    expect(describeAnswer("file", { files: [] }, field("ssm"), "en")).toEqual({ kind: "empty" });
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(describeAnswer("image", { image: png, mime: "image/png" }, field("logo"), "en")).toEqual({ kind: "image", src: png });
    expect(describeAnswer("image", { image: "https://evil.example/x.png", mime: "image/png" }, field("logo"), "en")).toEqual({ kind: "image", src: null });
    expect(imageSrc("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(imageSrc('data:image/png;base64,AAAA" onerror="x')).toBeNull();
  });

  it("is empty without a value", () => {
    expect(describeAnswer("text", null, field("legalName"), "en")).toEqual({ kind: "empty" });
  });
});

describe("groupAnswers", () => {
  it("groups by part in the form's order and orders each part's fields as the form does, keeping a part with no answers", () => {
    const rows = [
      answer({ key: "terms", type: "acknowledge", value: { checked: true } }),
      answer({ key: "bizType", type: "choice", value: { text: "sdn_bhd" }, label: L("Type", "Jenis"), source: "contact" }),
      answer({ key: "account", type: "text", part: "bank", role: "finance", value: { text: "1234567890" } }),
      answer({ key: "legalName", type: "multiline", value: null }),
    ];
    const groups = groupAnswers(progress({ answers: rows }), "ms");
    expect(groups.map((g) => g.partKey)).toEqual(["company", "bank", "docs"]);
    expect(groups[0].title).toBe("Syarikat dan cukai");
    expect(groups[0].roleLabel).toBe("Merchant");
    expect(groups[0].rows.map((r) => r.key)).toEqual(["legalName", "bizType", "terms"]);
    expect(groups[0].rows[1]).toMatchObject({ label: "Jenis", fromContact: true });
    expect(groups[0].answered).toBe(2);
    expect(groups[1].roleLabel).toBe("Finance");
    expect(groups[2].rows).toEqual([]);
  });

  it("marks a value the sender set, and never loses an answer of a part the form does not have", () => {
    const groups = groupAnswers(progress({ answers: [answer({ key: "x", type: "text", part: "old", value: { text: "kept" }, source: "sender" })] }), "en");
    const old = groups.find((g) => g.partKey === "old");
    expect(old?.rows[0]).toMatchObject({ bySender: true, fromContact: false });
  });

  it("names who types a part that was handed to someone else, and says nothing for a part its own person holds", () => {
    const base = progress();
    const withDelegate = progress({ roles: base.roles.map((r) => (r.roleKey === "merchant" ? { ...r, delegations: [{ part: "docs", name: " Siti Aminah ", done: false }] } : r)) });
    const groups = groupAnswers(withDelegate, "en");
    expect(groups.find((g) => g.partKey === "docs")?.typedBy).toBe("Siti Aminah");
    expect(groups.find((g) => g.partKey === "company")).not.toHaveProperty("typedBy");
    expect(groupAnswers(base, "en").some((g) => "typedBy" in g)).toBe(false);
  });
});

describe("issueViews", () => {
  it("words an answer that does not fit with the answer's label, and anything else generically", () => {
    const v = issueViews(
      [
        { code: "answer_does_not_fit", field: "legalName", detail: "p1" },
        { code: "invalid_answers", field: "bizType" },
        { code: "something_else" },
      ],
      form,
      "ms",
    );
    expect(v).toEqual([
      { key: "doesNotFit", field: "Legal name", code: "answer_does_not_fit" },
      { key: "invalid", field: "Jenis", code: "invalid_answers" },
      { key: "generic", field: "", code: "something_else" },
    ]);
  });
});

describe("the files a sender may download", () => {
  it("builds the route address for a file, escaping the ids", () => {
    expect(uploadedFileUrl("d1", "f1")).toBe("/api/sign/documents/d1/files/f1");
    expect(uploadedFileUrl("d 1", "../x")).toBe("/api/sign/documents/d%201/files/..%2Fx");
  });
});

describe("extending the expiry", () => {
  const now = new Date(2026, 9, 6, 10, 0, 0); // 6 Oct 2026, 10:00 local
  const expiry = new Date(2026, 9, 10, 8, 0, 0).toISOString(); // 10 Oct, 08:00 local

  it("is allowed while the document is open and the reader may send", () => {
    expect(canExtendExpiry("sent", true)).toBe(true);
    expect(canExtendExpiry("in_progress", true)).toBe(true);
    expect(canExtendExpiry("in_progress", false)).toBe(false);
    for (const s of ["draft", "sealing", "completed", "declined", "expired", "voided", "failed"]) expect(canExtendExpiry(s, true)).toBe(false);
  });

  it("wants a day, in the future, after the current expiry", () => {
    expect(extendProblem("", expiry, now)).toBe("required");
    expect(extendProblem("not a date", expiry, now)).toBe("required");
    expect(extendProblem("2026-10-05", null, now)).toBe("past");
    expect(extendProblem("2026-10-08", expiry, now)).toBe("not_later");
    // the same day ends at 23:59, which is later than 08:00 on that day
    expect(extendProblem("2026-10-10", expiry, now)).toBeNull();
    expect(extendProblem("2026-10-20", expiry, now)).toBeNull();
    expect(extendProblem("2026-10-20", null, now)).toBeNull();
  });

  it("offers the day the document expires, or today, as the earliest day, and suggests a week on", () => {
    expect(extendMinDate(expiry, now)).toBe("2026-10-10");
    expect(extendMinDate(new Date(2026, 9, 1).toISOString(), now)).toBe("2026-10-06");
    expect(extendMinDate(null, now)).toBe("2026-10-06");
    expect(suggestedExpiryDate(expiry, now)).toBe("2026-10-17");
    expect(suggestedExpiryDate(null, now)).toBe("2026-10-13");
    expect(extendProblem(suggestedExpiryDate(expiry, now), expiry, now)).toBeNull();
  });
});

describe("progressErrorKey", () => {
  it("words the codes it knows and falls back to a generic sentence", () => {
    expect(progressErrorKey("document_not_open")).toBe("errors.document_not_open");
    expect(progressErrorKey("nope")).toBe("errors.generic");
    expect(progressErrorKey(undefined)).toBe("errors.generic");
  });
});
