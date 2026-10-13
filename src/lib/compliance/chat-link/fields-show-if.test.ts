import { describe, expect, it } from "vitest";

import { answersFromForm, emptyForm, errorKey, missingRequired } from "@/components/compliance/helpers";

import { checkAnswers, isShown, validateFieldDefs, visibleFields } from "../fields";
import { parsePublicSubmission } from "../public/validate";
import type { FieldDef } from "../types";
import { ACCOUNT_CHANGE_FIELDS } from "./test-support";

// Conditional fields (migration 185: Account change asks for the pair that belongs to what is changing) and the closure form's rule that the registered phone
// number may come from the chat instead of the form.

const FIELDS = ACCOUNT_CHANGE_FIELDS as unknown as FieldDef[];
const keys = (f: FieldDef[]) => f.map((x) => x.key);

describe("a field that depends on another", () => {
  it("is shown only while the controlling answer is one of the listed values", () => {
    const newPhone = FIELDS.find((f) => f.key === "new_phone")!;
    expect(isShown(newPhone, FIELDS, { what_changes: "parent_phone" })).toBe(true);
    expect(isShown(newPhone, FIELDS, { what_changes: " parent_phone " })).toBe(true);
    for (const v of [{}, { what_changes: "" }, { what_changes: "parent_email" }, { what_changes: "parent_name" }, { what_changes: 7 }, { what_changes: null }]) expect(isShown(newPhone, FIELDS, v)).toBe(false);
    // a field with no condition is always shown
    expect(isShown(FIELDS[0], FIELDS, {})).toBe(true);
  });

  it("gives the fields of each choice, in the type's order, and only the first until a choice is made", () => {
    expect(keys(visibleFields(FIELDS, {}))).toEqual(["what_changes"]);
    expect(keys(visibleFields(FIELDS, { what_changes: "parent_phone" }))).toEqual(["what_changes", "current_phone", "new_phone"]);
    expect(keys(visibleFields(FIELDS, { what_changes: "parent_email" }))).toEqual(["what_changes", "current_email", "new_email"]);
    expect(keys(visibleFields(FIELDS, { what_changes: "child_name" }))).toEqual(["what_changes", "child_current_name", "child_new_name"]);
    expect(keys(visibleFields(FIELDS, { what_changes: "parent_name" }))).toEqual(["what_changes"]);
  });

  it("is checked, normalised and required only when shown", () => {
    const ok = checkAnswers(FIELDS, { what_changes: "parent_phone", current_phone: "012-334 4556", new_phone: "019 888 7766", new_email: "ignored@example.test" });
    expect(ok).toMatchObject({ ok: true, answers: { data: { what_changes: "parent_phone", current_phone: "+60123344556", new_phone: "+60198887766" } } });
    expect((ok as { answers: { data: object } }).answers.data).not.toHaveProperty("new_email");
    // a hidden field is never required, and never judged: a bad value in it does not block
    expect(checkAnswers(FIELDS, { what_changes: "parent_phone", current_phone: "012-334 4556", new_phone: "019 888 7766", new_email: "nope" }).ok).toBe(true);
    // the shown one is
    expect(checkAnswers(FIELDS, { what_changes: "parent_phone", current_phone: "012-334 4556" })).toEqual({ ok: false, issues: [{ field: "new_phone", code: "required" }] });
    expect(checkAnswers(FIELDS, { what_changes: "parent_email", current_email: "a@example.test", new_email: "nope" })).toEqual({ ok: false, issues: [{ field: "new_email", code: "invalid" }] });
  });

  it("will not take a parent's name, or no choice", () => {
    expect(checkAnswers(FIELDS, { what_changes: "parent_name" })).toEqual({ ok: false, issues: [{ field: "what_changes", code: "not_a_choice" }] });
    expect(checkAnswers(FIELDS, {})).toEqual({ ok: false, issues: [{ field: "what_changes", code: "required" }] });
  });

  it("lets an edit that sends one field use the choice already stored", () => {
    expect(checkAnswers(FIELDS, { new_email: "b@example.test" }, { partial: true, context: { what_changes: "parent_email" } })).toMatchObject({ ok: true, answers: { data: { new_email: "b@example.test" } } });
    expect(checkAnswers(FIELDS, { new_email: "b@example.test" }, { partial: true, context: { what_changes: "parent_phone" } })).toMatchObject({ ok: true, answers: { data: {} } });
    // what is sent decides over what is stored
    expect(checkAnswers(FIELDS, { what_changes: "child_name", child_new_name: "Aiman" }, { partial: true, context: { what_changes: "parent_phone" } })).toMatchObject({ ok: true, answers: { data: { what_changes: "child_name", child_new_name: "Aiman" } } });
  });

  it("is kept by the definition check, and refused when it is not a condition", () => {
    const ok = validateFieldDefs(FIELDS);
    expect(ok.ok).toBe(true);
    expect((ok as { fields: FieldDef[] }).fields.find((f) => f.key === "new_phone")?.showIf).toEqual({ field: "what_changes", in: ["parent_phone"] });
    for (const bad of [{ field: "Bad Key", in: ["a"] }, { field: "x", in: [] }, { field: "x" }, "x", [], { field: "x", in: [1] }]) {
      const r = validateFieldDefs([{ ...FIELDS[0] }, { key: "y", type: "text", label: { en: "Y" }, showIf: bad }]);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect((r as { issues: { code: string }[] }).issues[0].code).toBe("bad_show_if");
    }
  });
});

describe("the dialog's helpers follow the same condition", () => {
  it("ask for, and send, only the fields of the choice", () => {
    const values = { ...emptyForm(FIELDS), what_changes: "parent_email", current_email: "a@example.test", new_email: "b@example.test", current_phone: "012", child_new_name: "X" };
    expect(missingRequired(FIELDS, { ...emptyForm(FIELDS) })).toEqual(["what_changes"]);
    expect(missingRequired(FIELDS, { ...emptyForm(FIELDS), what_changes: "child_name" })).toEqual(["child_current_name", "child_new_name"]);
    expect(missingRequired(FIELDS, values)).toEqual([]);
    expect(answersFromForm(FIELDS, values)).toEqual({ what_changes: "parent_email", current_email: "a@example.test", new_email: "b@example.test" });
  });

  it("know the new error codes", () => {
    expect(errorKey("form_link_not_allowed")).toBe("form_link_not_allowed");
    expect(errorKey("form_link_submitted")).toBe("form_link_submitted");
  });
});

describe("the closure form when the phone number comes from the chat", () => {
  const body = {
    wantClose: "yes",
    name: "Siti Aminah",
    childrenFinished: true,
    allowancesStopped: true,
    bankChoice: "Maybank",
    accountNumber: "8800123456789012",
    accountHolder: "Siti Aminah",
    declaration: true,
  };
  const rules = { maxAmount: 0, banks: ["Maybank"] };

  it("is refused without a phone number on the public form, and accepted without one when the case has it", () => {
    expect(parsePublicSubmission("closure", body, rules)).toEqual({ ok: false, problems: { phone: "required" } });
    const ok = parsePublicSubmission("closure", body, { ...rules, phoneFromCase: true });
    expect(ok).toMatchObject({ ok: true, value: { name: "Siti Aminah", phone: "", needsLetter: false } });
  });

  it("ignores what is typed in a phone field it does not ask for, and still holds every other rule", () => {
    expect(parsePublicSubmission("closure", { ...body, phone: "garbage" }, { ...rules, phoneFromCase: true })).toMatchObject({ ok: true, value: { phone: "" } });
    expect(parsePublicSubmission("closure", { ...body, childrenFinished: false, declaration: false }, { ...rules, phoneFromCase: true })).toEqual({
      ok: false,
      problems: { childrenFinished: "must_acknowledge", declaration: "must_acknowledge" },
    });
    expect(parsePublicSubmission("closure", { ...body, accountHolder: "Ahmad" }, { ...rules, phoneFromCase: true })).toMatchObject({ ok: true, value: { needsLetter: true } });
  });
});
