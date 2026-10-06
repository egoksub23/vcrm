import { beforeEach, describe, expect, it } from "vitest";

import { parseFormInput } from "../registration/validate";
import { REGISTRATION_MODES, type RegistrationFormRow } from "../registration/types";
import type { FormDefinition } from "../forms";
import type { SignRole } from "../types";
import type { SignCtx } from "./context";
import { FakeDb } from "./fake-db";
import { buildRegisterView } from "./registration";
import { createForm, formOptions, formReadiness, updateForm, type TemplateState } from "./registration-forms";

// A registration page that sends a form without a signature (migration 169): its mode is `form`, it needs a template of that mode, and
// its page words say "complete your details", not "read and sign".

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const T_SIGN = "55555555-5555-4555-8555-555555555555";
const T_FORM = "66666666-6666-4666-8666-666666666666";

const signRoles: SignRole[] = [{ key: "merchant", label: "Merchant", kind: "signer", color: 0 }];
const formRoles: SignRole[] = [{ key: "applicant", label: "Applicant", kind: "filler", color: 0 }];
const FORM: FormDefinition = { version: 1, parts: [{ key: "p", title: { en: "Details" }, role: "applicant" }], fields: [{ key: "tin", type: "text", part: "p", label: { en: "TIN" }, required: true }] };

let db: FakeDb;
let ctx: SignCtx;

beforeEach(() => {
  db = new FakeDb();
  ctx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps: {} as SignCtx["deps"], now: () => new Date("2026-10-06T08:00:00Z") };
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur", owner_user_id: USER, brand_logo_url: null }]);
  db.seed("sign_templates", [
    { id: T_SIGN, account_id: ACCT, name: "Merchant Application", status: "active", current_version_id: "vS" },
    { id: T_FORM, account_id: ACCT, name: "E-invoice details", status: "active", current_version_id: "vF", mode: "form" },
  ]);
  db.seed("sign_template_versions", [
    { id: "vS", account_id: ACCT, template_id: T_SIGN, version_no: 1, source_path: "p", source_sha256: "a".repeat(64), page_count: 1, fields: [{ key: "sig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.08, required: true }], roles: signRoles, form: null, defaults: {} },
    { id: "vF", account_id: ACCT, template_id: T_FORM, version_no: 1, source_path: "p", source_sha256: "b".repeat(64), page_count: 1, fields: [], roles: formRoles, form: FORM, defaults: {}, mode: "form" },
  ]);
  db.seed("tags", []);
});

const form = (over: Partial<RegistrationFormRow> = {}): Pick<RegistrationFormRow, "send_document" | "template_id" | "applicant_role_key" | "signers_other" | "mode"> => ({
  send_document: true,
  template_id: T_FORM,
  applicant_role_key: "applicant",
  signers_other: [],
  mode: "form",
  ...over,
});

const stateOf = async (id: string): Promise<TemplateState> => {
  const t = db.rows("sign_templates").find((x) => x.id === id)!;
  const v = db.rows("sign_template_versions").find((x) => x.id === t.current_version_id)!;
  return { name: String(t.name), status: String(t.status), version: v as never };
};

describe("what a registration form may be told", () => {
  it("accepts the two modes and refuses anything else", () => {
    expect(REGISTRATION_MODES).toEqual(["sign", "form"]);
    expect(parseFormInput({ mode: "form" })).toEqual({ ok: true, value: { mode: "form" } });
    expect(parseFormInput({ mode: "sign" })).toEqual({ ok: true, value: { mode: "sign" } });
    expect(parseFormInput({ mode: "survey" })).toMatchObject({ ok: false, issues: [{ code: "bad_mode", field: "mode" }] });
    expect(parseFormInput({ mode: 3 })).toMatchObject({ ok: false });
    expect(parseFormInput({})).toEqual({ ok: true, value: {} });
  });
});

describe("a registration form that sends a form without a signature", () => {
  it("is ready with a template of its own mode, without any signer or signature", async () => {
    expect(formReadiness(form(), await stateOf(T_FORM))).toEqual([]);
  });

  it("is not ready with the other kind of template, either way round", async () => {
    expect(formReadiness(form({ template_id: T_SIGN, applicant_role_key: "merchant" }), await stateOf(T_SIGN))).toEqual([{ code: "template_mode_mismatch" }]);
    expect(formReadiness(form({ mode: "sign" }), await stateOf(T_FORM))).toEqual([{ code: "template_mode_mismatch" }]);
    expect(formReadiness(form({ mode: undefined }), await stateOf(T_FORM))).toEqual([{ code: "template_mode_mismatch" }]);
  });

  it("leaves an agreement form as it was: a signer and a signature are still needed", async () => {
    expect(formReadiness(form({ mode: "sign", template_id: T_SIGN, applicant_role_key: "merchant" }), await stateOf(T_SIGN))).toEqual([]);
  });

  it("follows the template it is given when the admin chooses none, and a switch of template moves the mode with it", async () => {
    const made = await createForm(ctx, { name: "E-invoice sign-up", templateId: T_FORM, applicantRoleKey: "applicant" });
    expect(made.mode).toBe("form");
    const agreement = await createForm(ctx, { name: "Merchant sign-up", templateId: T_SIGN, applicantRoleKey: "merchant" });
    expect(agreement.mode ?? "sign").toBe("sign");
    const switched = await updateForm(ctx, agreement.id, { templateId: T_FORM, applicantRoleKey: "applicant" });
    expect(switched.mode).toBe("form");
    const back = await updateForm(ctx, agreement.id, { templateId: T_SIGN, applicantRoleKey: "merchant" });
    expect(back.mode).toBe("sign");
  });

  it("refuses to switch on when the mode and the template disagree, with the reason", async () => {
    const made = await createForm(ctx, { name: "Mixed", templateId: T_SIGN, applicantRoleKey: "merchant" });
    await expect(updateForm(ctx, made.id, { mode: "form", active: true })).rejects.toMatchObject({ code: "form_not_ready", issues: [{ code: "template_mode_mismatch" }] });
  });

  it("offers each template with its mode", async () => {
    const o = await formOptions(ctx);
    expect(o.templates.map((t) => [t.name, t.mode]).sort()).toEqual([["E-invoice details", "form"], ["Merchant Application", "sign"]]);
  });

  it("gives its page the words of a form, and an agreement page keeps its own", () => {
    const found = (mode: "sign" | "form") => ({ form: { ...(form({ mode }) as unknown as RegistrationFormRow), slug: "x-aaaaaaaa", fields: {}, consent_text: {}, success_message: {}, default_locale: "en" as const }, workspace: { name: "Vircle", logoUrl: null } });
    expect(buildRegisterView(found("form") as never, "tok", null).documentMode).toBe("form");
    expect(buildRegisterView(found("sign") as never, "tok", null).documentMode).toBe("sign");
  });
});
