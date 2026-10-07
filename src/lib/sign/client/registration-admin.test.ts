import { describe, expect, it } from "vitest";

import { DEFAULT_ASKED, REGISTRATION_REASONS, type RegistrationFormRow } from "@/lib/sign/registration/types";

import { copiesFromList, emptyCopy } from "./copy-form";
import { copyIssueKey, copyIssueWords, draftFrom, issueKey, newDraft, previewAddress, reasonKey, toPayload, type FormOptions } from "./registration-admin";

const options: Pick<FormOptions, "templates"> = {
  templates: [
    {
      id: "tpl",
      name: "Merchant Application",
      hasForm: true,
      roles: [
        { key: "merchant", label: "Merchant", kind: "signer" },
        { key: "finance", label: "Finance", kind: "filler" },
        { key: "director", label: "Director", kind: "signer" },
      ],
    },
  ],
};

const filled = () => ({ ...newDraft(), name: "Merchant sign-up", templateId: "tpl", applicantRoleKey: "merchant" });

describe("the request a draft becomes", () => {
  it("is complete for a form that sends a document", () => {
    const r = toPayload({ ...filled(), others: { director: { name: " Siti ", email: " SITI@Vircle.example " } }, contactTagId: "tag", dailyCap: "40", consentText: { en: " We keep it. ", ms: "", zh: "", ko: "" } }, options);
    expect(r).toEqual({
      ok: true,
      payload: {
        name: "Merchant sign-up",
        active: false,
        sendDocument: true,
        templateId: "tpl",
        applicantRoleKey: "merchant",
        signersOther: [{ role_key: "director", name: "Siti", email: "siti@vircle.example", channel: "email", phone: null }],
        copyRecipients: [],
        contactTagId: "tag",
        fields: { full_name: "required", email: "required", phone: "optional", company: "required" },
        consentText: { en: "We keep it." },
        successMessage: {},
        defaultLocale: "en",
        dailyCap: 40,
      },
    });
  });

  it("always asks for the email, whatever else is set", () => {
    const r = toPayload({ ...filled(), phone: "off", company: "optional", fullName: "optional" }, options);
    expect(r.ok && r.payload.fields).toEqual({ full_name: "optional", email: "required", phone: "off", company: "optional" });
  });

  it("says what is missing before anything is sent", () => {
    const problems = (d: Partial<ReturnType<typeof filled>>) => {
      const r = toPayload({ ...filled(), ...d }, options);
      return r.ok ? null : r.problems;
    };
    expect(problems({ name: "  " })).toEqual({ name: "required" });
    expect(problems({ name: "x".repeat(121) })).toEqual({ name: "too_long" });
    expect(problems({ templateId: "" })).toEqual({ template: "required" });
    expect(problems({ templateId: "gone" })).toEqual({ template: "required" });
    expect(problems({ applicantRoleKey: "" })).toEqual({ applicantRole: "required" });
    expect(problems({ applicantRoleKey: "ghost" })).toEqual({ applicantRole: "required" });
    for (const cap of ["", "0", "5001", "1.5", "ten", "-3", " "]) expect(problems({ dailyCap: cap }), cap).toEqual({ dailyCap: "invalid" });
    expect(problems({ others: { director: { name: "Siti", email: "" } } })).toEqual({ others: "incomplete" });
    expect(problems({ others: { director: { name: "", email: "siti@vircle.example" } } })).toEqual({ others: "incomplete" });
    expect(problems({ others: { director: { name: "Siti", email: "nope" } } })).toEqual({ others: "invalid" });
    expect(problems({ name: "", dailyCap: "0", templateId: "" })).toEqual({ name: "required", dailyCap: "invalid", template: "required" });
  });

  it("leaves a role empty when both its fields are empty, and drops people for the applicant's role or a role the template lacks", () => {
    const r = toPayload({ ...filled(), others: { director: { name: "", email: "" }, merchant: { name: "Self", email: "self@x.example" }, ghost: { name: "G", email: "g@x.example" } } }, options);
    expect(r.ok && r.payload.signersOther).toEqual([]);
  });

  it("keeps no template, role or people for a form that sends no document", () => {
    const r = toPayload({ ...filled(), sendDocument: false, templateId: "", applicantRoleKey: "", others: { director: { name: "Siti", email: "siti@vircle.example" } } }, options);
    expect(r).toMatchObject({ ok: true, payload: { sendDocument: false, templateId: null, applicantRoleKey: null, signersOther: [] } });
  });

  it("does not need a template for a form that sends no document, even with none to choose", () => {
    expect(toPayload({ ...newDraft(), name: "Newsletter", sendDocument: false }, { templates: [] })).toMatchObject({ ok: true });
    expect(toPayload({ ...newDraft(), name: "Merchant" }, { templates: [] })).toEqual({ ok: false, problems: { template: "required" } });
  });
});

describe("a form being edited", () => {
  const row: RegistrationFormRow = {
    id: "f1",
    account_id: "a",
    slug: "merchant-sign-up-7k2m9x4q",
    name: "Merchant sign-up",
    active: true,
    mode: "sign",
    send_document: true,
    template_id: "tpl",
    applicant_role_key: "merchant",
    signers_other: [{ role_key: "director", name: "Siti", email: "siti@vircle.example", channel: "email", phone: null }],
    copy_recipients: [
      { fullName: "Mei Lin", email: "mei@vircle.example" },
      { fullName: "Raj", email: "raj@vircle.example" },
    ],
    contact_tag_id: "tag",
    fields: { ...DEFAULT_ASKED, phone: "off" },
    consent_text: { ms: "Kata-kata." },
    success_message: { en: "Thanks" },
    default_locale: "ms",
    daily_cap: 40,
    created_by: "u",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  };

  it("starts from the saved form and sends the same thing back when nothing changed", () => {
    const d = draftFrom(row);
    expect(d).toMatchObject({ name: "Merchant sign-up", active: true, templateId: "tpl", applicantRoleKey: "merchant", contactTagId: "tag", phone: "off", dailyCap: "40", defaultLocale: "ms" });
    expect(d.others).toEqual({ director: { name: "Siti", email: "siti@vircle.example" } });
    expect(d.consentText).toEqual({ en: "", ms: "Kata-kata.", zh: "", ko: "" });
    const r = toPayload(d, options);
    expect(r).toMatchObject({ ok: true, payload: { name: row.name, active: true, templateId: "tpl", signersOther: row.signers_other, fields: { ...row.fields }, consentText: { ms: "Kata-kata." }, successMessage: { en: "Thanks" }, dailyCap: 40 } });
  });

  it("carries the people who receive a copy from the saved form to the request, and back as the same list", () => {
    const d = draftFrom(row);
    expect(d.copies.map((c) => [c.fullName, c.email])).toEqual([
      ["Mei Lin", "mei@vircle.example"],
      ["Raj", "raj@vircle.example"],
    ]);
    const r = toPayload(d, options);
    expect(r.ok && r.payload.copyRecipients).toEqual(row.copy_recipients);
    // a form saved before the list existed has none
    expect(draftFrom({ ...row, copy_recipients: undefined as never }).copies).toEqual([]);
    expect(newDraft().copies).toEqual([]);
  });

  it("sends the list trimmed, each address once, without a blank row, and sends an empty list when everyone was taken off (so it clears)", () => {
    const withList = (copies: ReturnType<typeof copiesFromList>) => toPayload({ ...draftFrom(row), copies }, options);
    const r = withList([...copiesFromList([{ fullName: " Mei Lin ", email: " MEI@vircle.example " }]), emptyCopy(), emptyCopy({ fullName: "Mei again", email: "mei@VIRCLE.example" })]);
    expect(r.ok && r.payload.copyRecipients).toEqual([{ fullName: "Mei Lin", email: "MEI@vircle.example" }]);
    const none = withList([]);
    expect(none.ok && none.payload.copyRecipients).toEqual([]);
  });

  it("holds the save while a person is started but not complete, and says so under the field", () => {
    const r = toPayload({ ...draftFrom(row), copies: [emptyCopy({ fullName: "Mei" })] }, options);
    expect(r).toEqual({ ok: false, problems: { copies: "incomplete" } });
    expect(toPayload({ ...draftFrom(row), copies: [emptyCopy({ email: "mei@vircle.example" })] }, options)).toEqual({ ok: false, problems: { copies: "incomplete" } });
    expect(toPayload({ ...draftFrom(row), copies: [emptyCopy()] }, options)).toMatchObject({ ok: true });
  });

  it("keeps no list for a form that sends no document, and does not hold its save for a half-typed one", () => {
    const d = { ...draftFrom(row), sendDocument: false, templateId: "", applicantRoleKey: "", copies: [emptyCopy({ fullName: "Mei" }), ...copiesFromList([{ fullName: "Raj", email: "raj@vircle.example" }])] };
    const r = toPayload(d, options);
    expect(r).toMatchObject({ ok: true, payload: { sendDocument: false, copyRecipients: [] } });
  });

  it("has sensible starting values for a new form", () => {
    expect(newDraft()).toMatchObject({ active: false, sendDocument: true, fullName: "required", company: "required", phone: "optional", dailyCap: "100", defaultLocale: "en" });
  });
});

describe("the address while the name is typed", () => {
  it("shows the readable start with a placeholder for the random end", () => {
    expect(previewAddress("https://halo.test/", "Merchant sign-up")).toBe("https://halo.test/r/merchant-sign-up-xxxxxxxx");
    expect(previewAddress("https://halo.test", "")).toBe("https://halo.test/r/register-xxxxxxxx");
    expect(previewAddress("https://halo.test", "Kedai Runcit & Sons")).toBe("https://halo.test/r/kedai-runcit-sons-xxxxxxxx");
  });
});

describe("words for codes", () => {
  it("has a sentence for every reason and issue, and a general one for a code it has not seen", () => {
    for (const r of REGISTRATION_REASONS) expect(reasonKey(r)).toBe(`reasons.${r}`);
    expect(reasonKey("from_the_future")).toBe("reasons.generic");
    expect(reasonKey(null)).toBe("reasons.generic");
    expect(issueKey("role_without_person")).toBe("issues.role_without_person");
    expect(issueKey("bad_role_key")).toBe("issues.generic");
  });

  it("words each refusal of the copy list, with the person as the reader counts them, and leaves other fields alone", () => {
    for (const c of ["copy_name", "copy_email", "copy_duplicate", "too_many_copies", "bad_copy_list"]) expect(copyIssueKey(c)).toBe(`copies.issues.${c}`);
    expect(copyIssueKey("from_the_future")).toBe("copies.issues.generic");
    expect(
      copyIssueWords([
        { code: "copy_name", field: "copyRecipients", detail: "0" },
        { code: "copy_duplicate", field: "copyRecipients", detail: "2" },
        { code: "too_many_copies", field: "copyRecipients" },
        { code: "bad_copy_list", field: "copyRecipients", detail: "not a number" },
        { code: "bad_role", field: "applicantRoleKey" },
        { code: "signer_name", field: "signersOther", detail: "1" },
      ]),
    ).toEqual([
      { key: "copies.issues.copy_name", number: "1" },
      { key: "copies.issues.copy_duplicate", number: "3" },
      { key: "copies.issues.too_many_copies", number: "" },
      { key: "copies.issues.bad_copy_list", number: "" },
    ]);
    expect(copyIssueWords([])).toEqual([]);
  });
});
