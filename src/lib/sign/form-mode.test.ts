import { describe, expect, it } from "vitest";

import { eventSentence, certificateLabels } from "./certificate-words";
import { addFillerRole, partsOfRole, removeRole, renameRole, roleKeyFor, rolesNeedNames } from "./client/form-roles";
import { draftProblems } from "./client/draft-problems";
import { problemKey, problemStep } from "./client/errors";
import { DEFAULT_CONSENT, DEFAULT_CONSENT_FORM, consentFor } from "./consent";
import { MASK_CHAR, PRINT_MASK_CHAR, submissionSummary, type FormDefinition, type FormValue, type L10n } from "./forms";
import { completedEmail, declinedEmail, expiredEmail, forwardEmail, invitationEmail, reminderEmail } from "./messages";
import { recordLabels, LANGUAGE_NAMES } from "./record-words";
import { DEFAULT_RECORD_LABELS } from "./pdf/record";
import type { PlacedField } from "./pdf/types";
import { modeProblems, sendProblems, type SignerDraft } from "./rules";
import { SIGN_LOCALES, isFormMode, type SignRole } from "./types";

const filler: SignRole = { key: "applicant", label: "Applicant", kind: "filler", color: 0 };
const signer: SignRole = { key: "merchant", label: "Merchant", kind: "signer", color: 1 };
const L = (en: string, ms?: string): L10n => ({ en, ...(ms ? { ms } : {}) });
const FORM: FormDefinition = { version: 1, parts: [{ key: "p1", title: L("Company"), role: "applicant" }], fields: [] };

const person = (over: Partial<SignerDraft> = {}): SignerDraft => ({ role_key: "applicant", kind: "filler", full_name: "Ali", email: "ali@example.test", channel: "email", order_no: 1, ...over });
const place = (type: PlacedField["type"], over: Partial<PlacedField> = {}): PlacedField => ({ key: "f1", type, role: "applicant", page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.05, required: true, ...over });
const base = { pageCount: 1, hasBaseFile: true, signInOrder: false } as const;
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("isFormMode", () => {
  it("is true for the string and for a row, and false for everything else", () => {
    expect(isFormMode("form")).toBe(true);
    expect(isFormMode({ mode: "form" })).toBe(true);
    expect(isFormMode("sign")).toBe(false);
    expect(isFormMode({ mode: "sign" })).toBe(false);
    expect(isFormMode({})).toBe(false);
    expect(isFormMode(null)).toBe(false);
    expect(isFormMode(undefined)).toBe(false);
  });
});

describe("what a form without a signature may not hold", () => {
  it("has nothing to say about an agreement", () => {
    expect(modeProblems("sign", { roles: [signer], fields: [place("signature", { role: "merchant" })] })).toEqual([]);
    expect(modeProblems(undefined, { roles: [signer], fields: [place("signature", { role: "merchant" })] })).toEqual([]);
  });

  it("refuses a role that signs, a signature, initials, a signing date and any other place on the page", () => {
    const issues = modeProblems("form", {
      roles: [filler, signer],
      fields: [place("signature", { key: "a" }), place("initials", { key: "b" }), place("date_signed", { key: "c" }), place("text", { key: "d" })],
    });
    expect(issues).toEqual([
      { code: "form_mode_signer_role", role: "merchant" },
      { code: "form_mode_signature", field: "a" },
      { code: "form_mode_signature", field: "b" },
      { code: "form_mode_signature", field: "c" },
      { code: "form_mode_placement", field: "d" },
    ]);
  });

  it("wants a part only when asked to (a template starts empty)", () => {
    expect(modeProblems("form", { roles: [filler], fields: [], form: null })).toEqual([]);
    expect(modeProblems("form", { roles: [filler], fields: [], form: null }, { requireParts: true })).toEqual([{ code: "form_mode_needs_a_form" }]);
    expect(modeProblems("form", { roles: [filler], fields: [], form: { version: 1, parts: [], fields: [] } }, { requireParts: true })).toEqual([{ code: "form_mode_needs_a_form" }]);
    expect(modeProblems("form", { roles: [filler], fields: [], form: FORM }, { requireParts: true })).toEqual([]);
  });
});

describe("sendProblems for each mode", () => {
  it("lets a form go with only a person who fills it in: no signer, no signature", () => {
    expect(sendProblems({ ...base, mode: "form", fields: [], roles: [filler], signers: [person()] })).toEqual([]);
  });

  it("calls an empty list a missing person for a form and a missing signer for an agreement", () => {
    expect(codes(sendProblems({ ...base, mode: "form", fields: [], roles: [filler], signers: [] }))).toEqual(["no_person"]);
    expect(codes(sendProblems({ ...base, fields: [place("signature", { role: "merchant" })], roles: [signer], signers: [] }))).toEqual(["no_signer", "role_without_person"]);
  });

  it("keeps an agreement exactly as it was: a filler alone is not enough, and a signer needs a signature place", () => {
    expect(codes(sendProblems({ ...base, fields: [place("text")], roles: [filler], signers: [person()] }))).toContain("no_signer");
    expect(codes(sendProblems({ ...base, mode: "sign", fields: [place("text", { role: "merchant" })], roles: [signer], signers: [person({ role_key: "merchant", kind: "signer" })] }))).toEqual(["signer_without_signature"]);
    expect(sendProblems({ ...base, mode: "sign", fields: [place("signature", { role: "merchant" })], roles: [signer], signers: [person({ role_key: "merchant", kind: "signer" })] })).toEqual([]);
  });

  it("still checks the people the same way for a form: a name, an email, a role and one person once when ordered", () => {
    const found = sendProblems({ ...base, mode: "form", signInOrder: true, fields: [], roles: [filler], signers: [person({ full_name: "" }), person({ email: "nope" }), person({ role_key: "ghost" })] });
    expect(codes(found)).toEqual(expect.arrayContaining(["signer_name", "signer_email", "signer_role"]));
    const twice = sendProblems({ ...base, mode: "form", signInOrder: true, fields: [], roles: [filler], signers: [person(), person({ order_no: 2 })] });
    expect(codes(twice)).toContain("same_person_twice");
  });

  it("reports the signature and the roles of a form in the same pass", () => {
    const found = sendProblems({ ...base, mode: "form", fields: [place("signature")], roles: [signer], signers: [person({ role_key: "merchant" })] });
    expect(codes(found)).toEqual(expect.arrayContaining(["form_mode_signature", "form_mode_signer_role"]));
  });
});

describe("the sender's review of a draft, in the browser", () => {
  const rows = [{ key: "r1", roleKey: "applicant", fullName: "Ali", email: "ali@example.test", phone: "", channel: "email" as const, step: 1 }];
  const options = { title: "E-invoice", categoryId: null, contactId: null, locale: "en" as const, message: "", expiryDate: "", reminderText: "3, 7", codeRequired: false, signInOrder: false, allowForwarding: false };

  it("is ready for a form with a part and a person, and asks for a part when there is none", () => {
    const facts = { fields: [], roles: [filler], pageCount: 1, hasBaseFile: true, form: FORM, mode: "form" as const };
    const ok = draftProblems({ facts, rows: rows as never, options, now: new Date("2026-10-06T00:00:00Z") });
    expect(codes(ok)).toEqual([]);
    const none = draftProblems({ facts: { ...facts, form: null }, rows: rows as never, options, now: new Date("2026-10-06T00:00:00Z") });
    expect(codes(none)).toEqual(["form_mode_needs_a_form"]);
  });

  it("words and places the new codes", () => {
    for (const code of ["no_person", "form_mode_needs_a_form", "form_mode_signature", "form_mode_placement", "form_mode_signer_role"]) expect(problemKey(code)).toBe(`problems.${code}`);
    expect(problemStep("no_person")).toBe("people");
    expect(problemStep("form_mode_needs_a_form")).toBe("fields");
  });
});

describe("the consent of a form without a signature", () => {
  it("says submit, in each language, with a version of its own", () => {
    for (const l of SIGN_LOCALES) {
      const c = consentFor(null, l, "form");
      expect(c.text).toBe(DEFAULT_CONSENT_FORM[l]);
      expect(c.text).not.toBe(DEFAULT_CONSENT[l]);
      expect(c.version).toBe(`default-form-v1-${l}`);
      expect(c.custom).toBe(false);
      // an agreement keeps its own words and version
      expect(consentFor(null, l).version).toBe(`default-v1-${l}`);
      expect(consentFor(null, l, "sign").text).toBe(DEFAULT_CONSENT[l]);
    }
    expect(DEFAULT_CONSENT_FORM.en).toContain("submit");
    expect(DEFAULT_CONSENT_FORM.ms).toContain("menghantar");
    expect(DEFAULT_CONSENT_FORM.zh).toContain("提交");
    expect(DEFAULT_CONSENT_FORM.ko).toContain("제출");
  });

  it("gives way to the workspace's own wording for either kind", () => {
    const own = { en: "Our own words." };
    expect(consentFor(own, "en", "form").text).toBe("Our own words.");
    expect(consentFor(own, "en", "form").custom).toBe(true);
    expect(consentFor(own, "en", "sign").version).toBe(consentFor(own, "en", "form").version);
    // another language falls back to the form's default, not the agreement's
    expect(consentFor(own, "ms", "form").text).toBe(DEFAULT_CONSENT_FORM.ms);
  });
});

const base64 = { workspace: "Vircle", sender: "Gokula", signerName: "Ali", title: "E-invoice details", link: "https://halo.test/s/abc", codeRequired: false } as const;

describe("the messages of a form without a signature", () => {
  it("invites to complete details in every language, with nothing to sign and the link", () => {
    for (const locale of SIGN_LOCALES) {
      const m = invitationEmail({ ...base64, locale, mode: "form" });
      const agreement = invitationEmail({ ...base64, locale });
      expect(m.subject).not.toBe(agreement.subject);
      expect(m.subject).toContain("E-invoice details");
      expect(m.text).toContain("https://halo.test/s/abc");
      expect(m.html).toContain("https://halo.test/s/abc");
      expect(m.text + m.html).not.toMatch(/\{\w+\}/);
    }
    const en = invitationEmail({ ...base64, locale: "en", mode: "form" });
    expect(en.subject).toBe("Please complete your details: E-invoice details");
    expect(en.text).toContain("There is nothing to sign.");
    expect(en.text).toContain("Complete your details: https://halo.test/s/abc");
    expect(invitationEmail({ ...base64, locale: "ms", mode: "form" }).subject).toBe("Sila lengkapkan butiran anda: E-invoice details");
  });

  it("keeps the invitation of an agreement and of a filler on an agreement as it was", () => {
    expect(invitationEmail({ ...base64, locale: "en" }).subject).toBe("Gokula asked you to sign: E-invoice details");
    expect(invitationEmail({ ...base64, locale: "en", fill: true }).subject).toBe("Gokula asked you to complete: E-invoice details");
    expect(invitationEmail({ ...base64, locale: "en" }).text).toContain("Review and sign:");
  });

  it("reminds, with the parts left", () => {
    for (const locale of SIGN_LOCALES) {
      const m = reminderEmail({ ...base64, locale, mode: "form", partsLeft: ["Bank"] });
      expect(m.subject).not.toBe(reminderEmail({ ...base64, locale }).subject);
      expect(m.text).toContain("Bank");
      expect(m.text + m.html).not.toMatch(/\{\w+\}/);
    }
    const en = reminderEmail({ ...base64, locale: "en", mode: "form" });
    expect(en.subject).toBe("Reminder: please complete your details: E-invoice details");
    expect(en.text).toContain("Complete your details: https://halo.test/s/abc");
    expect(reminderEmail({ ...base64, locale: "en" }).subject).toBe("Reminder: please sign E-invoice details");
  });

  it("tells the submitter and the sender it was received, with the record attached or linked", () => {
    for (const locale of SIGN_LOCALES) {
      const m = completedEmail({ locale, workspace: "Vircle", name: "Ali", title: "E-invoice details", attached: true, downloadUrl: "https://halo.test/d", mode: "form" });
      expect(m.subject).not.toBe(completedEmail({ locale, workspace: "Vircle", name: "Ali", title: "E-invoice details", attached: true }).subject);
      expect(m.text).toContain("https://halo.test/d");
      expect(m.text + m.html).not.toMatch(/\{\w+\}/);
    }
    const en = completedEmail({ locale: "en", workspace: "Vircle", name: "Ali", title: "E-invoice details", attached: true, mode: "form" });
    expect(en.subject).toBe("Received: E-invoice details");
    expect(en.text).toContain("A record of what was submitted is attached");
    expect(en.text).not.toContain("signed");
    expect(completedEmail({ locale: "en", workspace: "Vircle", name: "Ali", title: "T", attached: true }).subject).toBe("Signed: T");
  });

  it("words a refusal, an expiry and a forwarded turn as a form", () => {
    for (const locale of SIGN_LOCALES) {
      expect(declinedEmail({ locale, workspace: "V", name: "Ali", title: "T", mode: "form" }).subject).not.toBe(declinedEmail({ locale, workspace: "V", name: "Ali", title: "T" }).subject);
      expect(expiredEmail({ locale, workspace: "V", title: "T", mode: "form" }).text).not.toBe(expiredEmail({ locale, workspace: "V", title: "T" }).text);
      const fwd = forwardEmail({ ...base64, locale, mode: "form", forwarder: "Siti" });
      expect(fwd.text).not.toBe(forwardEmail({ ...base64, locale, forwarder: "Siti" }).text);
      expect(fwd.text + fwd.html).not.toMatch(/\{\w+\}/);
    }
    expect(declinedEmail({ locale: "en", workspace: "V", name: "Ali", title: "T", mode: "form" }).text).toContain("declined to complete");
    expect(expiredEmail({ locale: "en", workspace: "V", title: "T", mode: "form" }).text).toContain("before everyone submitted");
  });
});

describe("the certificate and the history of a form without a signature", () => {
  it("heads the certificate as a submission and calls people submitted, in every language", () => {
    for (const l of SIGN_LOCALES) {
      const form = certificateLabels(l, "form");
      const sign = certificateLabels(l);
      expect(form.heading).not.toBe(sign.heading);
      expect(form.statusSigned).not.toBe(sign.statusSigned);
      expect(form.signers).not.toBe(sign.signers);
      // the words the form does not change are the agreement's
      expect(form.reference).toBe(sign.reference);
      expect(form.statusDeclined).toBe(sign.statusDeclined);
      expect(certificateLabels(l, "sign")).toEqual(sign);
    }
    expect(certificateLabels("en", "form").heading).toBe("Certificate of Submission");
  });

  it("words the events as submitting, and leaves the agreement's wording alone", () => {
    const names = { actor: "Ali", sender: "Gokula" };
    expect(eventSentence("submitted", "en", names, { mode: "form" })).toBe("Ali submitted their details");
    expect(eventSentence("submitted", "en", names)).toBe("Ali completed their part");
    expect(eventSentence("consented", "en", names, { mode: "form" })).toBe("Ali agreed to submit electronically");
    expect(eventSentence("consented", "en", names)).toBe("Ali agreed to sign electronically");
    expect(eventSentence("declined", "en", names, { mode: "form" })).toBe("Ali declined to complete the form");
    expect(eventSentence("sent", "en", names, { mode: "form" })).toBe("Gokula sent the form");
    expect(eventSentence("sealed", "en", names, { mode: "form" })).toBe("The submission record was sealed");
    expect(eventSentence("all_submitted", "en", names)).toBe("Everyone had submitted");
    // an event with no form wording reads as before
    expect(eventSentence("invited", "en", names, { mode: "form" })).toBe("Ali was invited");
    for (const l of SIGN_LOCALES) {
      for (const type of ["created", "sent", "viewed", "consented", "submitted", "declined", "sealed", "completed"]) {
        const form = eventSentence(type, l, names, { mode: "form" });
        expect(form, `${l} ${type}`).toBeTruthy();
        expect(form).not.toMatch(/\{\w+\}/);
      }
      expect(eventSentence("all_submitted", l, names)).toBeTruthy();
      expect(eventSentence("submitted", l, names, { mode: "form" })).not.toBe(eventSentence("submitted", l, names));
    }
  });
});

describe("the answers as words, part by part", () => {
  const form: FormDefinition = {
    version: 1,
    parts: [
      { key: "company", title: L("Company", "Syarikat"), role: "applicant" },
      { key: "tax", title: L("Tax"), role: "applicant", visibleIf: { op: "eq", field: "registered", value: "yes" } },
      { key: "docs", title: L("Documents"), role: "applicant" },
    ],
    fields: [
      { key: "legal", type: "text", part: "company", label: L("Legal name", "Nama sah"), required: true },
      { key: "tin", type: "text", part: "company", label: L("TIN"), required: true, sensitive: true },
      { key: "short", type: "text", part: "company", label: L("Short code"), required: false, sensitive: true },
      { key: "kind", type: "choice", part: "company", label: L("Kind"), required: false, options: [{ value: "sdn", label: L("Sdn. Bhd.", "Sdn. Bhd.") }, { value: "sole", label: L("Sole proprietor", "Pemilik tunggal") }] },
      { key: "registered", type: "yesno", part: "company", label: L("Registered for SST"), required: false },
      { key: "sst", type: "text", part: "tax", label: L("SST number"), required: false },
      { key: "ssm", type: "file", part: "docs", label: L("SSM extract"), required: false, accept: ["pdf"] },
      { key: "logo", type: "image", part: "docs", label: L("Logo"), required: false },
      { key: "note", type: "multiline", part: "docs", label: L("Note"), required: false, visibleIf: { op: "notEmpty", field: "legal" } },
    ],
  };
  const answers: Record<string, FormValue> = {
    legal: { text: "Kedai Runcit Ali Sdn Bhd" },
    tin: { text: "C20881234567" },
    short: { text: "AB12" },
    kind: { text: "sole" },
    registered: { checked: true },
    sst: { text: "SST-123" },
    ssm: { files: [{ id: "f1", name: "ssm.pdf", mime: "application/pdf", size: 2048, sha256: "a".repeat(64), path: "account-x/doc/upload/f1-ssm.pdf" }] },
    logo: { image: "data:image/png;base64,AAAA", mime: "image/png" },
  };

  it("reads each shown answer in the document's language, in the form's order", () => {
    const parts = submissionSummary(form, answers, "ms");
    expect(parts.map((p) => p.title)).toEqual(["Syarikat", "Tax", "Documents"]);
    const company = parts[0].rows;
    expect(company[0]).toMatchObject({ key: "legal", label: "Nama sah", text: "Kedai Runcit Ali Sdn Bhd", answered: true, sensitive: false });
    expect(company.find((r) => r.key === "kind")).toMatchObject({ text: "Pemilik tunggal" });
    expect(company.find((r) => r.key === "registered")).toMatchObject({ text: "Ya" });
    expect(parts[0].roleKey).toBe("applicant");
  });

  it("never gives a sensitive answer in full: a mask, and a different one where a font may lack the dot", () => {
    const screen = submissionSummary(form, answers, "en");
    expect(screen[0].rows.find((r) => r.key === "tin")).toMatchObject({ text: `${MASK_CHAR.repeat(4)} 4567`, sensitive: true });
    // a short value is only the dots, whatever its length (the mask never grows with the value)
    expect(screen[0].rows.find((r) => r.key === "short")!.text).toBe(MASK_CHAR.repeat(4));
    const pdf = submissionSummary(form, answers, "en", { maskChar: PRINT_MASK_CHAR });
    expect(pdf[0].rows.find((r) => r.key === "tin")!.text).toBe("**** 4567");
    expect(JSON.stringify(screen) + JSON.stringify(pdf)).not.toContain("C20881234567");
  });

  it("lists files with their names and fingerprints but never a path, and says a picture was given", () => {
    const docs = submissionSummary(form, answers, "en")[2].rows;
    expect(docs[0]).toMatchObject({ key: "ssm", files: [{ name: "ssm.pdf", size: 2048, sha256: "a".repeat(64) }], text: "", answered: true });
    expect(JSON.stringify(docs)).not.toContain("account-x");
    expect(docs[1]).toMatchObject({ key: "logo", picture: true, text: "", answered: true });
  });

  it("leaves out a part or a field the answers hide, and names a question nobody answered", () => {
    const hidden = submissionSummary(form, { ...answers, registered: { checked: false } }, "en");
    expect(hidden.map((p) => p.key)).toEqual(["company", "docs"]);
    const empty = submissionSummary(form, {}, "en");
    expect(empty.find((p) => p.key === "company")!.rows.every((r) => !r.answered)).toBe(true);
    // "Note" is shown only once the legal name has an answer
    expect(empty.find((p) => p.key === "docs")!.rows.map((r) => r.key)).toEqual(["ssm", "logo"]);
    expect(submissionSummary(form, answers, "en")[2].rows.map((r) => r.key)).toContain("note");
  });
});

describe("the words of the record's answer pages", () => {
  it("are written in every language, with the same fields as English", () => {
    for (const l of SIGN_LOCALES) {
      const words = recordLabels(l);
      expect(Object.keys(words).sort()).toEqual(Object.keys(DEFAULT_RECORD_LABELS).sort());
      for (const v of Object.values(words)) expect(v.length).toBeGreaterThan(0);
      expect(LANGUAGE_NAMES[l].length).toBeGreaterThan(1);
    }
    expect(recordLabels("ms").heading).not.toBe(recordLabels("en").heading);
    expect(recordLabels("zh").heading).toBe("提交记录");
  });
});

describe("the people who fill in a form without a signature", () => {
  const roles = [filler];

  it("makes a key from a label that is a role key, never taken and never the sender's", () => {
    expect(roleKeyFor("Accounts", ["applicant"])).toBe("accounts");
    expect(roleKeyFor("Accounts", ["accounts"])).toBe("accounts_2");
    expect(roleKeyFor("sender", [])).toBe("sender_2");
    expect(roleKeyFor("", [])).toBe("person");
    expect(roleKeyFor("123", [])).toMatch(/^[a-z]/);
    expect(roleKeyFor("Pengarah Syarikat", [])).toBe("pengarah_syarikat");
    expect(roleKeyFor("Finanzen", [])).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,39}$/);
  });

  it("adds a role that only fills in, with the first colour not in use, up to six", () => {
    let next = roles;
    for (let i = 0; i < 8; i++) next = addFillerRole(next, `Person ${i + 1}`);
    expect(next).toHaveLength(6);
    expect(next.every((r) => r.kind === "filler")).toBe(true);
    expect(new Set(next.map((r) => r.color)).size).toBe(6);
    expect(new Set(next.map((r) => r.key)).size).toBe(6);
    expect(addFillerRole(roles, "  ")[1].label).toBe("Person");
  });

  it("renames, and removes only a role nothing uses and never the last", () => {
    const two = addFillerRole(roles, "Accounts");
    expect(renameRole(two, "accounts", "Finance").find((r) => r.key === "accounts")!.label).toBe("Finance");
    expect(partsOfRole(FORM, "applicant")).toBe(1);
    expect(removeRole(two, "applicant", FORM)).toHaveLength(2); // a part uses it
    expect(removeRole(two, "accounts", FORM).map((r) => r.key)).toEqual(["applicant"]);
    expect(removeRole(roles, "applicant", { version: 1, parts: [], fields: [] })).toHaveLength(1); // the last stays
    expect(rolesNeedNames(renameRole(two, "accounts", "  "))).toBe(true);
    expect(rolesNeedNames(two)).toBe(false);
  });
});
