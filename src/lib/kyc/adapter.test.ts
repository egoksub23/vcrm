// The adapter is the one place that guesses the doc-processor back end's field names (they are PROVISIONAL: the Postman collection has no examples).
// These tests pin the guesses, the tolerance for odd shapes, the masking and the "never send a link to the browser" rule. When real samples arrive,
// add them here as fixtures and correct adapter.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADAPTER_GUESSES,
  buildValidation,
  extractItems,
  extractSignedUrl,
  maskValue,
  norm,
  parseValidations,
  sortNewestFirst,
  statusTone,
  toIso,
} from "./adapter";

const sample = {
  id: "val_123",
  friend_id: "child-77",
  type: "nric",
  status: "verified",
  created_at: "2026-10-01T08:30:00Z",
  updated_at: "2026-10-01T08:31:00Z",
  confidence: 0.934,
  full_name: "Aisyah binti Ali",
  nric: "150304101234",
  date_of_birth: "2015-03-04",
  address: "12 Jalan Mawar, 50000 Kuala Lumpur",
  extracted: { gender: "F", expiry: "2030-01-01" },
  image_url: "https://bucket.s3.amazonaws.com/secret/key.jpg?X-Amz-Signature=abc",
};

describe("norm", () => {
  it("compares keys without case or separators", () => {
    expect(norm("created_at")).toBe("createdat");
    expect(norm("createdAt")).toBe("createdat");
    expect(norm("Created-At")).toBe("createdat");
  });
});

describe("extractItems: the list in whatever shape arrives", () => {
  const rec = { id: "1", status: "ok" };
  it("takes a bare array", () => expect(extractItems([rec, rec])).toHaveLength(2));
  it.each(["validations", "items", "data", "results", "records", "Validations"])("takes an array under %s", (key) => {
    expect(extractItems({ [key]: [rec], total: 1 })).toEqual([rec]);
  });
  it("takes an array one level down ({ data: { validations: [...] } })", () => {
    expect(extractItems({ data: { validations: [rec, rec, rec] }, ok: true })).toHaveLength(3);
  });
  it("takes a single record", () => {
    expect(extractItems(rec)).toEqual([rec]);
    expect(extractItems({ data: rec })).toEqual([rec]);
  });
  it("reads an empty array, an empty object and null list keys as nothing on file", () => {
    expect(extractItems([])).toEqual([]);
    expect(extractItems({})).toEqual([]);
    expect(extractItems({ validations: [] })).toEqual([]);
    expect(extractItems({ data: null })).toEqual([]);
  });
  it("skips non-object entries but refuses a list of nothing but scalars", () => {
    expect(extractItems([rec, "x", 3, null])).toEqual([rec]);
    expect(extractItems(["a", "b"])).toBeNull();
  });
  it("refuses anything that is not a list: an error message, text, a number, null", () => {
    expect(extractItems({ message: "Forbidden" })).toBeNull();
    expect(extractItems({ error: "bad", code: 12 })).toBeNull();
    expect(extractItems("nope")).toBeNull();
    expect(extractItems(7)).toBeNull();
    expect(extractItems(null)).toBeNull();
    expect(extractItems(undefined)).toBeNull();
  });
});

describe("buildValidation: known fields under any likely name", () => {
  it("picks the known fields and keeps the rest in a generic list", () => {
    const v = buildValidation(sample);
    expect(v).toMatchObject({
      id: "val_123",
      idUsable: true,
      friendId: "child-77",
      type: "NRIC",
      status: { raw: "verified", tone: "positive" },
      createdAt: "2026-10-01T08:30:00.000Z",
      updatedAt: "2026-10-01T08:31:00.000Z",
      score: "93.4%",
      fallback: false,
    });
    expect(v.known.map((f) => f.key)).toEqual(["name", "idNumber", "dob", "address"]);
    expect(v.known[0]).toMatchObject({ label: "Name", value: "Aisyah binti Ali", sensitive: false, masked: false });
    // what is left: the nested object's scalars, with their dotted paths
    expect(v.extra.map((f) => f.key)).toEqual(["extracted.gender", "extracted.expiry"]);
  });

  it("works with camelCase and other spellings", () => {
    const v = buildValidation({ validationId: "v9", friendId: "f1", documentType: "passport", validationStatus: "Rejected", createdAt: 1790000000, score: "0.5", dob: "2014-01-01", idNumber: "A12345678" });
    expect(v).toMatchObject({ id: "v9", friendId: "f1", type: "PASSPORT", status: { raw: "Rejected", tone: "negative" }, score: "50%" });
    expect(v.createdAt).toBe(new Date(1790000000 * 1000).toISOString());
    expect(v.known.map((f) => f.key)).toEqual(["idNumber", "dob"]);
  });

  it("reads a status that is a nested object or a boolean", () => {
    expect(buildValidation({ id: "1", result: { status: "pass" } }).status).toEqual({ raw: "pass", tone: "positive" });
    expect(buildValidation({ id: "1", verified: true, ok: false }).status.raw).toBeNull();
    expect(buildValidation({ id: "1", status: false }).status).toEqual({ raw: "false", tone: "negative" });
  });

  it("copes with a record that has none of the known fields: everything goes in the generic list and the fallback flag is set", () => {
    const v = buildValidation({ foo: "bar", n: 3, flag: true, nested: { deep: { deeper: "x" } } });
    expect(v.fallback).toBe(true);
    expect(v.id).toBe("");
    expect(v.idUsable).toBe(false);
    expect(v.extra.map((f) => [f.key, f.value])).toEqual([["foo", "bar"], ["n", "3"], ["flag", "true"], ["nested.deep.deeper", "x"]]);
  });

  it("does not take a nested id for the record's id", () => {
    expect(buildValidation({ user: { id: "u1" }, status: "ok" }).id).toBe("");
  });

  it("marks an id with characters the image route would refuse as unusable", () => {
    expect(buildValidation({ id: "a/b" }).idUsable).toBe(false);
    expect(buildValidation({ id: "a b" }).idUsable).toBe(false);
    expect(buildValidation({ id: ".." }).idUsable).toBe(false);
    expect(buildValidation({ id: ".hidden" }).idUsable).toBe(false);
    expect(buildValidation({ id: 42 }).idUsable).toBe(true);
    expect(buildValidation({ id: "x".repeat(201) }).idUsable).toBe(false);
  });

  it("survives null, empty and odd values, long text, control characters and bidi overrides", () => {
    const v = buildValidation({ id: "1", status: null, reason: "", message: "line1\nline2\u0000\u202ecod.exe", note: "x".repeat(400), list: [1, "two", { three: 3 }], empty: {}, none: [] });
    expect(v.status.raw).toBeNull();
    expect(v.reason).toBe("line1 line2 cod.exe");
    expect(v.extra.map((f) => f.key)).toEqual(["note", "list.0", "list.1", "list.2.three"]);
    expect(v.extra[0].value).toHaveLength(300);
    expect(v.extra[0].value?.endsWith("…")).toBe(true);
    expect(v.extra.find((f) => f.key === "list.2.three")?.value).toBe("3");
  });

  it("caps a very large record", () => {
    const big: Record<string, unknown> = { id: "1" };
    for (let i = 0; i < 500; i++) big[`field${i}`] = `v${i}`;
    expect(buildValidation(big).extra.length).toBeLessThanOrEqual(120);
  });
});

describe("masking happens in the adapter, before anything leaves the server", () => {
  it("masks the ID number (first 2 and last 2), hides the date of birth and the address, and keeps the name", () => {
    const v = buildValidation(sample);
    const byKey = Object.fromEntries(v.known.map((f) => [f.key, f]));
    expect(byKey.idNumber).toMatchObject({ value: "15••••••34", sensitive: true, masked: true });
    expect(byKey.dob).toMatchObject({ value: null, sensitive: true, masked: true });
    expect(byKey.address).toMatchObject({ value: null, sensitive: true, masked: true });
    expect(byKey.name.masked).toBe(false);
    expect(v.hasMasked).toBe(true);
  });

  it("never lets a real value through in a masked view, anywhere in the serialised object", () => {
    const json = JSON.stringify(buildValidation(sample));
    for (const secret of ["150304101234", "2015-03-04", "Jalan Mawar", "50000", "secret/key.jpg", "amazonaws", "X-Amz"]) {
      expect(json, secret).not.toContain(secret);
    }
  });

  it("masks by key pattern in the generic list too (phone, email, guardian, nested document number)", () => {
    const v = buildValidation({ id: "1", phone_number: "0123456789", guardian_name: "Parent X", contact: { email: "a@b.my" }, docs: { visa_document_no: "A1234567890" }, colour: "fine" });
    const m = Object.fromEntries(v.extra.map((f) => [f.key, f]));
    expect(m.phone_number).toMatchObject({ sensitive: true, masked: true, value: null });
    expect(m.guardian_name).toMatchObject({ sensitive: true, masked: true, value: null });
    expect(m["contact.email"]).toMatchObject({ sensitive: true, masked: true, value: null });
    expect(m["docs.visa_document_no"]).toMatchObject({ sensitive: true, masked: true, value: "A1••••••90" });
    expect(m.colour).toMatchObject({ sensitive: false, masked: false, value: "fine" });
    const json = JSON.stringify(v);
    for (const secret of ["0123456789", "Parent X", "a@b.my", "A1234567890"]) expect(json, secret).not.toContain(secret);
  });

  it("shows everything when reveal is asked for, and says nothing is masked any more", () => {
    const v = buildValidation(sample, { reveal: true });
    const byKey = Object.fromEntries(v.known.map((f) => [f.key, f]));
    expect(byKey.idNumber).toMatchObject({ value: "150304101234", sensitive: true, masked: false });
    expect(byKey.dob.value).toBe("2015-03-04");
    expect(byKey.address.value).toContain("Jalan Mawar");
    expect(v.hasMasked).toBe(false);
  });

  it("maskValue: partial keeps 2+2 of a long value with a fixed number of dots; short values and hidden mode show nothing", () => {
    expect(maskValue("150304101234", "partial")).toBe("15••••••34");
    expect(maskValue("1503041012345678901", "partial")).toBe("15••••••01");
    expect(maskValue("123456789", "partial")).toBeNull();
    expect(maskValue("2015-03-04", "hidden")).toBeNull();
    expect(maskValue("", "partial")).toBeNull();
  });
});

describe("links and storage references never reach the browser", () => {
  it("withholds URLs, signed URLs, storage keys, tokens and long blobs, and counts them", () => {
    const v = buildValidation({
      id: "1",
      status: "ok",
      image_url: "https://x.example/a.jpg",
      document: { s3_key: "kyc/abc/def.jpg", bucket: "b" },
      thumbnail: "s3://bucket/key",
      download_link: "/files/abc",
      auth_token: "tok_123",
      raw_image: "A".repeat(700),
      selfie: "kyc/selfie/123.jpg",
      comment: "see https://evil.example for details",
      face_match_score: 0.9,
      image_quality: 0.8,
    });
    const keys = v.extra.map((f) => f.key);
    expect(keys).toEqual(["face_match_score", "image_quality"]);
    expect(v.withheld).toBeGreaterThanOrEqual(7);
    const json = JSON.stringify(v);
    for (const leak of ["x.example", "s3_key", "kyc/abc", "s3://", "/files/abc", "tok_123", "AAAAAAAA", "kyc/selfie"]) expect(json, leak).not.toContain(leak);
  });

  it("withholds a link even when it is in a field taken for a known role", () => {
    const v = buildValidation({ id: "https://x.example/1", status: "ok", reason: "https://x.example/why" });
    expect(v.id).toBe("");
    expect(v.reason).toBeNull();
    expect(v.withheld).toBe(2);
  });
});

describe("statusTone", () => {
  it.each([
    ["approved", "positive"], ["Verified", "positive"], ["PASSED", "positive"], ["ok", "positive"], ["success", "positive"], ["true", "positive"],
    ["pending", "pending"], ["in_review", "pending"], ["processing", "pending"], ["under review", "pending"], ["manualReview", "pending"], ["in_progress", "pending"],
    ["rejected", "negative"], ["failed", "negative"], ["invalid", "negative"], ["mismatch", "negative"], ["not_verified", "negative"], ["unverified", "negative"], ["verification_failed", "negative"], ["no_match", "negative"],
    ["weird", "neutral"], ["", "neutral"], [null, "neutral"],
  ])("%s is %s", (word, tone) => expect(statusTone(word as string | null)).toBe(tone));

  it("shows an unknown word as neutral and keeps the raw word", () => {
    const v = buildValidation({ id: "1", status: "escalated-tier-2" });
    expect(v.status).toEqual({ raw: "escalated-tier-2", tone: "neutral" });
  });
});

describe("toIso", () => {
  it("reads ISO text, epoch seconds, epoch milliseconds and numeric text", () => {
    expect(toIso("2026-10-01T08:30:00+08:00")).toBe("2026-10-01T00:30:00.000Z");
    expect(toIso(1790000000)).toBe(new Date(1790000000000).toISOString());
    expect(toIso(1790000000000)).toBe(new Date(1790000000000).toISOString());
    expect(toIso("1790000000")).toBe(new Date(1790000000000).toISOString());
  });
  it("refuses what is not a plausible time", () => {
    expect(toIso("yesterday")).toBeNull();
    expect(toIso(12)).toBeNull();
    expect(toIso(true)).toBeNull();
    expect(toIso("1970-01-01T00:00:00Z")).toBeNull();
    expect(toIso("2300-01-01")).toBeNull();
  });
  it("keeps the vendor's text when it cannot be read", () => {
    const v = buildValidation({ id: "1", created_at: "last Tuesday" });
    expect(v.createdAt).toBeNull();
    expect(v.createdAtRaw).toBe("last Tuesday");
  });
});

describe("parseValidations", () => {
  const a = { id: "a", created_at: "2026-10-01T00:00:00Z", status: "ok", nric: "150304101234" };
  const b = { id: "b", created_at: "2026-10-03T00:00:00Z", status: "pending", nric: "160405101234" };
  const c = { id: "c", status: "failed" };

  it("sorts newest first and puts records without a time last", () => {
    const r = parseValidations({ validations: [c, a, b] })!;
    expect(r.items.map((v) => v.id)).toEqual(["b", "a", "c"]);
  });

  it("returns null for a body that is not a list", () => {
    expect(parseValidations({ message: "x" })).toBeNull();
  });

  it("reveals only the validation asked for", () => {
    const r = parseValidations([a, b], { revealId: "a" })!;
    const ids = Object.fromEntries(r.items.map((v) => [v.id, v.known.find((f) => f.key === "idNumber")!]));
    expect(ids.a).toMatchObject({ value: "150304101234", masked: false });
    expect(ids.b).toMatchObject({ value: "16••••••34", masked: true });
    expect(JSON.stringify(r.items.find((v) => v.id === "b"))).not.toContain("160405101234");
  });

  it("does not reveal anything for an id that matches nothing, or an empty id", () => {
    const r = parseValidations([{ nric: "150304101234" }], { revealId: "" })!;
    expect(JSON.stringify(r)).not.toContain("150304101234");
    const r2 = parseValidations([a], { revealId: "zzz" })!;
    expect(JSON.stringify(r2)).not.toContain("150304101234");
  });

  it("clamps to the limit and says when every record fell back to the generic table", () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ x: i }));
    const r = parseValidations(many, { limit: 50 })!;
    expect(r.items).toHaveLength(50);
    expect(r.fallback).toBe(true);
    expect(parseValidations([a])!.fallback).toBe(false);
    expect(parseValidations([])!.fallback).toBe(false);
  });

  it("sortNewestFirst is stable", () => {
    const rows = [{ createdAt: null, n: 1 }, { createdAt: null, n: 2 }, { createdAt: "2026-01-01T00:00:00Z", n: 3 }];
    expect(sortNewestFirst(rows).map((r) => r.n)).toEqual([3, 1, 2]);
  });
});

describe("extractSignedUrl", () => {
  const ok = (body: string, status = 200, location: string | null = null) => extractSignedUrl({ status, location, bodyText: body });
  it.each([
    ['{"url":"https://a.example/x.jpg?sig=1"}', "https://a.example/x.jpg?sig=1"],
    ['{"signed_url":"https://a.example/x"}', "https://a.example/x"],
    ['{"signedUrl":"https://a.example/x"}', "https://a.example/x"],
    ['{"link":"https://a.example/x"}', "https://a.example/x"],
    ['{"data":{"url":"https://a.example/x"}}', "https://a.example/x"],
    ['{"body":{"presigned_url":"https://a.example/x"},"ok":true}', "https://a.example/x"],
    ['"https://a.example/x"', "https://a.example/x"],
    ["https://a.example/x", "https://a.example/x"],
    ["  https://a.example/x\n", "https://a.example/x"],
  ])("finds the URL in %s", (body, url) => expect(ok(body)).toBe(url));

  it("reads the Location of a redirect and does not need a body", () => {
    expect(ok("", 302, "https://a.example/redirected")).toBe("https://a.example/redirected");
    expect(ok("", 307, "/relative/path")).toBe("/relative/path");
    expect(ok("", 302, null)).toBeNull();
  });

  it("returns null when there is no URL, or the body is not one", () => {
    for (const body of ["", "{}", '{"url":123}', '{"url":"javascript:alert(1)"}', '{"message":"no"}', "not a url", "[1,2]", "{broken"]) expect(ok(body), body).toBeNull();
  });
});

// A record as the PRODUCTION doc-processor sent it on 18 Oct 2026 (ids made up).
const PROD_RECORD = {
  id: 7,
  friend_id: "00000000-1111-2222-3333-444444444444",
  doc_type: "nric",
  s3_key: "Prod/00000000-1111-2222-3333-444444444444/nric_20261018T065853Z.jpg",
  job_status: "complete",
  capture_ok: true,
  capture_code: "ok",
  capture_message: "NRIC looks readable.",
  extracted_id: null,
  client_id_number: null,
  validation_status: "NO_ID_ON_CLIENT",
  detail: { source: "check", client_found: true, client_id_path: "duitnow.m.nric" },
  review_status: null,
  review_note: null,
  reviewed_at: null,
  created_at: "2026-10-18T06:58:53.123456+00:00",
};

describe("a record as the production back end sends it", () => {
  it("reads the type, status, reason, friend id and time, and never passes the storage key on", () => {
    const v = buildValidation(PROD_RECORD);
    expect(v).toMatchObject({ id: "7", idUsable: true, friendId: PROD_RECORD.friend_id, type: "NRIC", reason: "NRIC looks readable.", fallback: false });
    expect(v.status).toEqual({ raw: "NO_ID_ON_CLIENT", tone: "pending" });
    expect(v.createdAt).toBe("2026-10-18T06:58:53.123Z");
    expect(JSON.stringify(v)).not.toContain("Prod/");
    expect(v.withheld).toBeGreaterThan(0);
  });

  it("colours UNREADABLE red and an unseen status by its words", () => {
    expect(buildValidation({ ...PROD_RECORD, validation_status: "UNREADABLE" }).status.tone).toBe("negative");
    expect(statusTone("NAME_MISMATCH")).toBe("negative");
    expect(statusTone("MATCH")).toBe("positive");
  });

  it("masks the ID numbers it reads off the card and finds on Vircle's record, and reveals them for one validation", () => {
    const filled = { ...PROD_RECORD, extracted_id: "150304101234", client_id_number: "150304101234" };
    const masked = buildValidation(filled);
    expect(masked.known.map((f) => [f.key, f.value, f.masked])).toEqual([
      ["idNumber", "15••••••34", true],
      ["clientIdNumber", "15••••••34", true],
    ]);
    expect(JSON.stringify(masked)).not.toContain("150304101234");
    expect(buildValidation(filled, { reveal: true }).known.map((f) => f.value)).toEqual(["150304101234", "150304101234"]);
  });

  it("reads the page as {items: [...]}, newest first", () => {
    const parsed = parseValidations({ items: [PROD_RECORD, { ...PROD_RECORD, id: 6, created_at: "2026-10-16T01:00:00+00:00" }] });
    expect(parsed?.items.map((v) => v.id)).toEqual(["7", "6"]);
    expect(parsed?.fallback).toBe(false);
    expect(parseValidations({ items: [] })?.items).toEqual([]);
  });
});

describe("the guesses are listed in one place", () => {
  it("exports every table the docs mention", () => {
    expect(ADAPTER_GUESSES.listKeys).toContain("validations");
    expect(ADAPTER_GUESSES.statusKeys).toContain("status");
    expect(ADAPTER_GUESSES.known.map((k) => k.name)).toEqual(["name", "idNumber", "clientIdNumber", "dob", "address"]);
    expect(ADAPTER_GUESSES.urlKeys).toContain("signedurl");
  });
});

describe("the engineers' documentation lists exactly what the adapter guesses", () => {
  // docs/kyc-review.md section 8 is where engineers look; this keeps it from drifting away from the tables above.
  const doc = readFileSync(join(process.cwd(), "docs", "kyc-review.md"), "utf8");
  const all: string[] = [
    ...ADAPTER_GUESSES.listKeys,
    ...ADAPTER_GUESSES.idKeys,
    ...ADAPTER_GUESSES.friendIdKeys,
    ...ADAPTER_GUESSES.typeKeys,
    ...ADAPTER_GUESSES.statusKeys,
    ...ADAPTER_GUESSES.createdKeys,
    ...ADAPTER_GUESSES.updatedKeys,
    ...ADAPTER_GUESSES.reasonKeys,
    ...ADAPTER_GUESSES.scoreKeys,
    ...ADAPTER_GUESSES.known.flatMap((k) => k.keys),
    ...ADAPTER_GUESSES.urlKeys,
  ];
  it("names every key the adapter tries", () => {
    const missing = [...new Set(all)].filter((k) => !doc.includes(`\`${k}\``));
    expect(missing).toEqual([]);
  });
  it("names every status word", () => {
    const words = [...ADAPTER_GUESSES.positiveWords, ...ADAPTER_GUESSES.pendingWords, ...ADAPTER_GUESSES.negativeWords];
    expect(words.filter((w) => !new RegExp(String.raw`(^|[ \x60])${w}([ \x60.,;]|$)`).test(doc))).toEqual([]);
  });
  it("names the three variables, the migration and the flag", () => {
    for (const s of ["KYC_DOC_API_BASE_URL", "KYC_DOC_API_KEY", "KYC_DOC_ALLOWED_IMAGE_HOSTS", "182", "`kyc`", "menu.kyc", "kyc.view", "kyc.reveal", "kyc_access_log"]) expect(doc, s).toContain(s);
  });
});

// ---- people and review (19 Oct 2026) ----
// The engineers' updated collection: every check names its `parent` and `child`, and carries review_status / review_note / reviewed_at once decided.
const WITH_PEOPLE = {
  id: 1842,
  friend_id: "41cc103a-5ffc-4949-b89d-f609ce392a29",
  doc_type: "nric",
  s3_key: "UAT/41cc103a/nric_20261009T012530Z.jpg",
  capture_ok: true,
  capture_code: "ok",
  capture_message: "NRIC looks readable.",
  extracted_id: "901010145678",
  client_id_number: "901010145678",
  validation_status: "MATCH",
  parent: { id: "parent-uuid", name: "Parent Name", nickname: "parent", identification: "A1234567", client_type: "APP", email: "parent@example.com", wallet_id: "8001000000001", phone_number: "60123456789" },
  child: { id: "41cc103a", name: "Child Name", nickname: "child", identification: "901010145678", client_type: "CARD", email: null, wallet_id: "8001000000002", phone_number: null },
  review_status: null,
  review_note: null,
  reviewed_at: null,
  created_at: "2026-10-09T01:25:31+00:00",
};

describe("the people a check names", () => {
  const fieldsOf = (v: ReturnType<typeof buildValidation>, role: string) => Object.fromEntries((v.people.find((p) => p.role === role)?.fields ?? []).map((f) => [f.key, f]));

  it("lists the child first, then the parent, each field masked by its own rule", () => {
    const v = buildValidation(WITH_PEOPLE);
    expect(v.people.map((p) => p.role)).toEqual(["child", "parent"]);
    const child = fieldsOf(v, "child");
    expect(Object.keys(child)).toEqual(["name", "nickname", "identification", "wallet", "clientType"]);
    expect(child.name).toMatchObject({ value: "Child Name", sensitive: false, masked: false });
    expect(child.identification).toMatchObject({ value: "90••••••78", sensitive: true, masked: true });
    expect(child.wallet).toMatchObject({ value: "80••••••02", masked: true });
    expect(child.clientType).toMatchObject({ value: "CARD", masked: false });
    const parent = fieldsOf(v, "parent");
    expect(Object.keys(parent)).toEqual(["name", "nickname", "identification", "email", "phone", "wallet", "clientType"]);
    expect(parent.email).toMatchObject({ value: null, masked: true });
    expect(parent.phone).toMatchObject({ value: null, masked: true });
    // an ID number shorter than ten characters is not shown even in part
    expect(parent.identification).toMatchObject({ value: null, masked: true });
    expect(v.hasMasked).toBe(true);
    const dump = JSON.stringify(v);
    for (const s of ["parent@example.com", "60123456789", "A1234567", "8001000000001", "8001000000002", "901010145678"]) expect(dump, s).not.toContain(s);
  });

  it("never takes the parent's (or the child's) name for the check's own, and leaves nothing of them in the other fields", () => {
    const v = buildValidation(WITH_PEOPLE);
    expect(v.known.map((f) => f.key)).toEqual(["idNumber", "clientIdNumber"]);
    expect(v.extra.map((f) => f.key).filter((k) => /parent|child|name|email|phone|wallet/i.test(k))).toEqual([]);
  });

  it("shows every field in full when the caller reveals this validation", () => {
    const v = buildValidation(WITH_PEOPLE, { reveal: true });
    expect(fieldsOf(v, "parent")).toMatchObject({ email: { value: "parent@example.com", masked: false }, phone: { value: "60123456789" }, identification: { value: "A1234567" }, wallet: { value: "8001000000001" } });
    expect(fieldsOf(v, "child").identification).toMatchObject({ value: "901010145678", masked: false });
  });

  it("counts, and does not send, anything else the object holds; a link in it is never sent either", () => {
    const v = buildValidation({ ...WITH_PEOPLE, child: { ...WITH_PEOPLE.child, photo_url: "https://cdn.example/x.jpg", favourite_colour: "blue" } });
    expect(JSON.stringify(v)).not.toContain("cdn.example");
    expect(JSON.stringify(v)).not.toContain("blue");
    expect(v.withheld).toBeGreaterThanOrEqual(buildValidation(WITH_PEOPLE).withheld + 2);
  });

  it("copes with a record that has no people, a null one, or one that is not an object", () => {
    expect(buildValidation({ ...WITH_PEOPLE, parent: undefined, child: undefined }).people).toEqual([]);
    expect(buildValidation({ ...WITH_PEOPLE, parent: null, child: "somebody" as unknown as object }).people).toEqual([]);
    expect(buildValidation({ ...WITH_PEOPLE, parent: {}, child: { id: "only-an-id" } }).people).toEqual([]);
  });

  it("is also found under another spelling of the key (Parent, CHILD)", () => {
    const v = buildValidation({ ...WITH_PEOPLE, parent: undefined, child: undefined, Parent: WITH_PEOPLE.parent, CHILD: WITH_PEOPLE.child });
    expect(v.people.map((p) => p.role)).toEqual(["child", "parent"]);
  });
});

describe("the decision a check carries", () => {
  it("is null until somebody has decided", () => {
    expect(buildValidation(WITH_PEOPLE).review).toBeNull();
    expect(buildValidation({ ...WITH_PEOPLE, review_status: "", review_note: "x" }).review).toBeNull();
  });

  it("reads status, note and time, and the status word decides the tone", () => {
    const approved = buildValidation({ ...WITH_PEOPLE, review_status: "APPROVED", review_note: "NRIC matches client record", reviewed_at: "2026-10-12T14:04:00+00:00" });
    expect(approved.review).toEqual({ raw: "APPROVED", tone: "positive", note: "NRIC matches client record", at: "2026-10-12T14:04:00.000Z" });
    const rejected = buildValidation({ ...WITH_PEOPLE, review_status: "REJECTED", review_note: "  Photo‮   does not\nmatch ", reviewed_at: null });
    expect(rejected.review).toEqual({ raw: "REJECTED", tone: "negative", note: "Photo does not match", at: null });
    expect(buildValidation({ ...WITH_PEOPLE, review_status: "APPROVED" }).review).toMatchObject({ note: null, at: null });
  });

  it("does not list the review fields again among the others, nor take reviewed_at for 'updated'", () => {
    const v = buildValidation({ ...WITH_PEOPLE, review_status: "APPROVED", review_note: "ok", reviewed_at: "2026-10-12T14:04:00+00:00" });
    expect(v.extra.map((f) => f.key).filter((k) => /review/i.test(k))).toEqual([]);
    expect(v.updatedAt).toBeNull();
  });

  it("reaches the list parser too", () => {
    const parsed = parseValidations({ items: [{ ...WITH_PEOPLE, review_status: "REJECTED" }, { ...WITH_PEOPLE, id: 1841 }] });
    expect(parsed?.items.map((v) => [v.id, v.review?.raw ?? null])).toEqual([["1842", "REJECTED"], ["1841", null]]);
  });

  // Production sends the two people at the top level AND again inside `detail`. Listed twice they filled the screen with raw key names
  // (`detail.child.identification` ...) and pushed everything a reviewer actually reads off the bottom.
  it("lists each person ONCE, however many copies of them the record carries", () => {
    const v = buildValidation({ ...WITH_PEOPLE, detail: { source: "api", client_found: true, child: WITH_PEOPLE.child, parent: WITH_PEOPLE.parent } });
    expect(v.people.map((p) => p.role)).toEqual(["child", "parent"]);
    const keys = v.extra.map((e) => e.key);
    expect(keys.filter((k) => /child|parent/.test(k))).toEqual([]);
    expect(keys).toContain("detail.source");
    // and the copy is not just hidden from the browser: it is not counted as withheld either
    expect(JSON.stringify(v.extra)).not.toContain("Parent Name");
  });

  it("takes the people from wherever they are, preferring the record's own over a copy nested deeper", () => {
    const nested = buildValidation({ id: 9, detail: { child: { name: "Nested Child" } } });
    expect(nested.people.map((p) => p.role)).toEqual(["child"]);
    expect(nested.extra.map((e) => e.key)).not.toContain("detail.child.name");
    const both = buildValidation({ id: 9, child: { name: "Own Child" }, detail: { child: { name: "Nested Child" } } });
    expect(both.people[0].fields.find((f) => f.key === "name")?.value).toBe("Own Child");
  });
});
