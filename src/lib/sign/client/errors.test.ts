import { describe, expect, it } from "vitest";

import type { PlacedField } from "../pdf/types";
import type { SignDocumentRow, SignRole } from "../types";
import { optionsFromDocument } from "./draft-options";
import { draftProblems, splitLayoutIssues } from "./draft-problems";
import { KNOWN_ERROR_CODES, dedupeIssues, errorKey, problemKey, problemStep } from "./errors";
import { emptyRow, type SignerRow } from "./signers-form";

describe("errorKey", () => {
  it("words each code it knows", () => {
    expect(errorKey("upload_too_large")).toBe("errors.upload_too_large");
    expect(errorKey("converter_unavailable")).toBe("errors.converter_unavailable");
    expect(errorKey("sign_limit_reached")).toBe("errors.sign_limit_reached");
  });

  it("falls back to a generic sentence for a code it has never seen", () => {
    expect(errorKey("something_new")).toBe("errors.generic");
    expect(errorKey(undefined)).toBe("errors.generic");
    expect(errorKey("")).toBe("errors.generic");
    expect(errorKey("request_failed")).toBe("errors.generic");
  });

  it("covers every code the upload pipeline throws", () => {
    for (const code of [
      "upload_empty",
      "upload_too_large",
      "upload_unsupported",
      "upload_name_mismatch",
      "upload_macros",
      "upload_zip_bomb",
      "upload_encrypted_word",
      "pdf_invalid",
      "pdf_encrypted",
      "pdf_too_many_pages",
      "pdf_empty",
      "pdf_too_large",
      "conversion_timeout",
      "conversion_failed",
      "conversion_too_long",
      "converter_not_configured",
      "converter_unavailable",
    ]) {
      expect(KNOWN_ERROR_CODES, code).toContain(code);
    }
  });
});

describe("problems", () => {
  it("send each kind to the step that fixes it", () => {
    expect(problemStep("signer_email")).toBe("people");
    expect(problemStep("same_person_twice")).toBe("people");
    expect(problemStep("role_without_person")).toBe("people");
    expect(problemStep("signer_without_signature")).toBe("fields");
    expect(problemStep("no_roles")).toBe("fields");
    expect(problemStep("outside_page")).toBe("fields");
    expect(problemStep("expiry_past")).toBe("options");
    expect(problemStep("title_required")).toBe("options");
  });

  it("put the many layout codes under one message", () => {
    expect(problemKey("outside_page")).toBe("problems.layout");
    expect(problemKey("duplicate_role")).toBe("problems.layout");
    expect(problemKey("signer_name")).toBe("problems.signer_name");
  });

  it("show a problem once", () => {
    expect(dedupeIssues([{ code: "signer_name", detail: "0" }, { code: "signer_name", detail: "0" }, { code: "signer_name", detail: "1" }])).toHaveLength(2);
  });

  it("collapse layout problems to a count", () => {
    const split = splitLayoutIssues([{ code: "outside_page", field: "a" }, { code: "too_small", field: "b" }, { code: "no_signer" }]);
    expect(split.layoutCount).toBe(2);
    expect(split.single).toEqual([{ code: "no_signer" }]);
  });
});

describe("draftProblems", () => {
  const roles: SignRole[] = [{ key: "merchant", label: "Merchant", kind: "signer", color: 0 }];
  const fields: PlacedField[] = [{ key: "f1", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05, required: true }];
  const facts = { fields, roles, pageCount: 1, hasBaseFile: true };
  const doc = { title: "T", category_id: null, contact_id: null, locale: "en", message: null, expires_at: null, reminder_days: [3, 7], code_required: false, sign_in_order: false } as unknown as SignDocumentRow;
  const options = optionsFromDocument(doc);
  const now = new Date(2026, 9, 6);
  const ok: SignerRow = { ...emptyRow("merchant"), fullName: "Ali", email: "ali@example.com" };

  it("is empty for a draft that can go", () => {
    expect(draftProblems({ facts, rows: [ok], options, now })).toEqual([]);
  });

  it("says only that fields are missing when the document has no roles yet", () => {
    expect(draftProblems({ facts: { ...facts, roles: [], fields: [] }, rows: [], options, now }).map((p) => p.code)).toEqual(["no_roles"]);
    expect(draftProblems({ facts: { ...facts, roles: [], fields: [], hasBaseFile: false }, rows: [], options, now }).map((p) => p.code)).toEqual(["no_file", "no_roles"]);
  });

  it("finds a half-filled row and an option the server would refuse", () => {
    const codes = draftProblems({ facts, rows: [{ ...ok, email: "ali@" }], options: { ...options, title: "", expiryDate: "2026-10-01" }, now }).map((p) => p.code);
    expect(codes).toContain("signer_email");
    expect(codes).toContain("title_required");
    expect(codes).toContain("expiry_past");
  });

  it("adds the server findings once", () => {
    const codes = draftProblems({ facts, rows: [], options, serverProblems: [{ code: "no_signer" }, { code: "something_server_only" }], now }).map((p) => p.code);
    expect(codes.filter((c) => c === "no_signer")).toHaveLength(1);
    expect(codes).toContain("something_server_only");
  });
});
