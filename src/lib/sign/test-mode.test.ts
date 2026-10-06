import { describe, expect, it } from "vitest";

import type { FormDefinition } from "./forms/types";
import type { PlacedField } from "./pdf/types";
import { isOwnAddress, mailbox, nameFromEmail, normalizeEmail, planTestSigners, rolesNeedingPeople } from "./test-mode";
import type { SignRole } from "./types";

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "finance", label: "Finance", kind: "filler", color: 1 },
  { key: "director", label: "Director", kind: "signer", color: 2 },
];
const sig = (role: string, key = `sig_${role}`): PlacedField => ({ key, type: "signature", role, page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06, required: true });
const form: FormDefinition = { version: 1, parts: [{ key: "bank", title: { en: "Bank" }, role: "finance" }], fields: [] };

describe("which roles need a person on a test", () => {
  it("is every role with something to sign or fill, or a part of the form, and not an unused one", () => {
    expect(rolesNeedingPeople(roles, [sig("merchant"), sig("director")], null).map((r) => r.key)).toEqual(["merchant", "director"]);
    expect(rolesNeedingPeople(roles, [sig("merchant"), sig("director")], form).map((r) => r.key)).toEqual(["merchant", "finance", "director"]);
    // a fixed value, a printed answer, a name and a signing date ask nobody anything
    const printed: PlacedField[] = [
      { key: "a", type: "static_text", role: "sender", text: "x", page: 0, x: 0, y: 0, w: 0.2, h: 0.04, required: false },
      { key: "b", type: "name", role: "finance", page: 0, x: 0, y: 0.1, w: 0.2, h: 0.04, required: true },
    ];
    expect(rolesNeedingPeople(roles, printed, null)).toEqual([]);
  });
});

describe("a person's own addresses", () => {
  it("knows a mailbox from its +tag, in any case", () => {
    expect(mailbox("Gokula+Director@Vircle.Example")).toBe("gokula@vircle.example");
    expect(mailbox("gokula@vircle.example")).toBe("gokula@vircle.example");
    expect(mailbox("+x@vircle.example")).toBe("+x@vircle.example");
    expect(normalizeEmail("  Gokula@Vircle.Example ")).toBe("gokula@vircle.example");
  });

  it("accepts an address they have and the same mailbox with a tag, and nothing else", () => {
    const own = ["gokula@vircle.example", "gokulak@gmail.com"];
    for (const ok of ["gokula@vircle.example", "GOKULA@vircle.example", "gokula+test@vircle.example", "gokulak+two@gmail.com"]) expect(isOwnAddress(ok, own), ok).toBe(true);
    for (const bad of ["ali@vircle.example", "gokula@vircle.example.evil.com", "gokula@gmail.com", "gokula+x@evil.example", "not an email", "", "g+okula@vircle.example"]) expect(isOwnAddress(bad, own), bad).toBe(false);
    expect(isOwnAddress("gokula@vircle.example", [])).toBe(false);
    expect(isOwnAddress(`${"a".repeat(250)}@x.example`, ["a@x.example"])).toBe(false);
  });

  it("names a person from their address when they have no name", () => {
    expect(nameFromEmail("Gokula@vircle.example")).toBe("gokula");
    expect(nameFromEmail("")).toBe("Tester");
  });
});

describe("who sits where on a test document", () => {
  const base = { roles, fields: [sig("merchant"), sig("director")], form: null, signInOrder: false, name: "Gokula", defaultEmail: "gokula@vircle.example", own: ["gokula@vircle.example"] };

  it("gives every needed role the person, named by role when there are several, in the template's order", () => {
    const r = planTestSigners(base);
    expect(r).toEqual({
      ok: true,
      plan: {
        orderIgnored: false,
        signers: [
          { roleKey: "merchant", kind: "signer", fullName: "Gokula (Merchant)", email: "gokula@vircle.example", orderNo: 1 },
          { roleKey: "director", kind: "signer", fullName: "Gokula (Director)", email: "gokula@vircle.example", orderNo: 2 },
        ],
      },
    });
  });

  it("names the person plainly when only one place is needed", () => {
    const r = planTestSigners({ ...base, fields: [sig("merchant")] });
    expect(r.ok && r.plan.signers).toEqual([{ roleKey: "merchant", kind: "signer", fullName: "Gokula", email: "gokula@vircle.example", orderNo: 1 }]);
  });

  it("flags the order as ignored only when it was asked for and one address holds several places", () => {
    expect(planTestSigners({ ...base, signInOrder: true })).toMatchObject({ ok: true, plan: { orderIgnored: true } });
    expect(planTestSigners({ ...base, signInOrder: false })).toMatchObject({ ok: true, plan: { orderIgnored: false } });
    const own = planTestSigners({ ...base, signInOrder: true, emails: { director: "gokula+two@vircle.example" } });
    expect(own).toMatchObject({ ok: true, plan: { orderIgnored: false } });
  });

  it("refuses an address that is not theirs, naming the role, and says when there is nobody to ask", () => {
    expect(planTestSigners({ ...base, emails: { merchant: "ali@kedai.example" } })).toEqual({ ok: false, error: { code: "test_email_not_yours", role: "merchant" } });
    expect(planTestSigners({ ...base, defaultEmail: "ali@kedai.example" })).toEqual({ ok: false, error: { code: "test_email_not_yours", role: "merchant" } });
    expect(planTestSigners({ ...base, fields: [] })).toEqual({ ok: false, error: { code: "test_no_roles" } });
  });

  it("includes a filler that holds a part of the form", () => {
    const r = planTestSigners({ ...base, form });
    expect(r.ok && r.plan.signers.map((s) => [s.roleKey, s.kind])).toEqual([
      ["merchant", "signer"],
      ["finance", "filler"],
      ["director", "signer"],
    ]);
  });
});
