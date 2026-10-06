import { describe, expect, it } from "vitest";

import type { FormDefinition } from "./forms";
import { MAX_FORWARDS, delegationsOf, forwardProblem, forwardsLeft, heldParts, isDelegate, maskEmail, mayAnswerPart, nameResolver, openDelegations, partsAnswered, partsShown, stepGroups, waitingNames } from "./forward";

const FORM: FormDefinition = {
  version: 1,
  parts: [
    { key: "company", title: { en: "Company" }, role: "merchant" },
    { key: "bank", title: { en: "Bank" }, role: "merchant" },
    { key: "owner", title: { en: "Owner" }, role: "director" },
  ],
  fields: [],
};

const merchant = { id: "m", role_key: "merchant", order_no: 1, part_keys: null };
const delegate = { id: "d", role_key: "merchant", order_no: 1, part_keys: ["bank"], delegated_by: "m", full_name: "Siti", status: "sent" as const };

describe("who owns a part", () => {
  it("a part handed to a delegate is answered by the delegate alone", () => {
    const held = heldParts([merchant, delegate]);
    expect([...held]).toEqual(["bank"]);
    const bank = FORM.parts[1];
    const company = FORM.parts[0];
    expect(mayAnswerPart(delegate, bank, held)).toBe(true);
    expect(mayAnswerPart(delegate, company, held)).toBe(false);
    expect(mayAnswerPart(merchant, bank, held)).toBe(false);
    expect(mayAnswerPart(merchant, company, held)).toBe(true);
    // never another role's part
    expect(mayAnswerPart({ role_key: "director", part_keys: null }, company, held)).toBe(false);
  });

  it("a signer sees the parts they handed over (read only) but answers only the others; a delegate sees only theirs", () => {
    expect(partsShown(FORM, merchant).map((p) => p.key)).toEqual(["company", "bank"]);
    expect(partsAnswered(FORM, merchant, [merchant, delegate]).map((p) => p.key)).toEqual(["company"]);
    expect(partsAnswered(FORM, merchant, [merchant]).map((p) => p.key)).toEqual(["company", "bank"]);
    expect(partsShown(FORM, delegate).map((p) => p.key)).toEqual(["bank"]);
    expect(partsAnswered(FORM, delegate, [merchant, delegate]).map((p) => p.key)).toEqual(["bank"]);
  });

  it("knows who is a delegate and what a signer has handed over", () => {
    expect(isDelegate(delegate)).toBe(true);
    expect(isDelegate(merchant)).toBe(false);
    expect(isDelegate({ part_keys: [] })).toBe(false);
    expect(delegationsOf([merchant, delegate], "m")).toEqual([{ part: "bank", signerId: "d", name: "Siti", done: false }]);
    expect(delegationsOf([merchant, delegate], "d")).toEqual([]);
    expect(openDelegations([merchant, { ...delegate, status: "signed" as const }], "m")).toEqual([]);
    expect(openDelegations([merchant, delegate], "m")).toHaveLength(1);
  });
});

describe("forwardProblem", () => {
  const who = { email: "ali@kedai.example", role_key: "merchant", forwardCount: 0 };
  const others = [
    { id: "p", email: "partner@kedai.example", role_key: "merchant" },
    { id: "dir", email: "dir@vircle.example", role_key: "director" },
  ];
  const check = (email: string, over: Partial<typeof who> = {}, ordered = false, extra: { except?: string } = {}) => forwardProblem({ name: "Siti", email }, { ...who, ...over }, { ordered }, others, extra);

  it("accepts a new person", () => {
    expect(check("siti@kedai.example")).toBeNull();
  });

  it("refuses a missing name, a bad address, yourself, someone already on the document for the role, and a position that has forwarded enough", () => {
    expect(forwardProblem({ name: " ", email: "a@b.example" }, who, { ordered: false }, others)).toBe("forward_details");
    expect(check("nope")).toBe("forward_details");
    expect(check(" Ali@Kedai.example ")).toBe("forward_same_person");
    expect(check("PARTNER@kedai.example")).toBe("forward_already_signer");
    expect(check("siti@kedai.example", { forwardCount: MAX_FORWARDS })).toBe("forward_limit");
    expect(forwardsLeft({ forward_count: 0 })).toBe(MAX_FORWARDS);
    expect(forwardsLeft({ forward_count: 5 })).toBe(0);
  });

  it("lets a person of another role be the recipient only when the document needs no order", () => {
    expect(check("dir@vircle.example")).toBeNull();
    expect(check("dir@vircle.example", {}, true)).toBe("forward_already_signer");
  });

  it("lets a second part go to the delegate the person already is", () => {
    const withDelegate = [...others, { id: "d", email: "siti@kedai.example", role_key: "merchant" }];
    expect(forwardProblem({ name: "Siti", email: "siti@kedai.example" }, who, { ordered: false }, withDelegate)).toBe("forward_already_signer");
    expect(forwardProblem({ name: "Siti", email: "siti@kedai.example" }, who, { ordered: false }, withDelegate, { except: "d" })).toBeNull();
  });
});

describe("maskEmail", () => {
  it("keeps the first letter and the domain, as the database writes it", () => {
    expect(maskEmail("ali@kedai.example")).toBe("a***@kedai.example");
    expect(maskEmail("@x.example")).toBe("***");
    expect(maskEmail(null)).toBe("***");
  });
});

describe("steps", () => {
  const people = [
    { order_no: 3, created_at: "3", id: "c" },
    { order_no: 1, created_at: "1", id: "a" },
    { order_no: 3, created_at: "2", id: "b" },
    { order_no: 1, created_at: "9", id: "z", part_keys: ["bank"] },
  ];

  it("groups people who share an order number, in signing order, numbering the steps 1, 2 whatever the order numbers were, and leaves delegates out", () => {
    const steps = stepGroups(people);
    expect(steps.map((s) => [s.step, s.orderNo, s.people.map((p) => p.id)])).toEqual([
      [1, 1, ["a"]],
      [2, 3, ["b", "c"]],
    ]);
  });

  it("names who the page waits for: everyone invited who has not finished", () => {
    expect(
      waitingNames([
        { name: "Ali", status: "signed" },
        { name: "Siti", status: "sent" },
        { name: "Lim", status: "viewed" },
        { name: "Later", status: "pending" },
      ]),
    ).toEqual(["Siti", "Lim"]);
  });
});

describe("nameResolver", () => {
  it("keeps the forwarder's name on what the forwarder did, and the current name on what came after", () => {
    const at = nameResolver(
      [{ id: "s", full_name: "Siti" }],
      [
        { type: "forwarded", signer_id: "s", created_at: "2026-10-06T08:00:00Z", detail: { from_name: "Ali" } },
        { type: "forwarded", signer_id: "s", created_at: "2026-10-06T10:00:00Z", detail: { from_name: "Siti" } },
      ],
    );
    expect(at("s", "2026-10-06T07:00:00Z")).toBe("Ali");
    expect(at("s", "2026-10-06T08:00:00Z")).toBe("Ali"); // the forward itself is the forwarder's act
    expect(at("s", "2026-10-06T09:00:00Z")).toBe("Siti");
    expect(at("s", "2026-10-06T11:00:00Z")).toBe("Siti"); // (the current name is whoever holds it now)
    expect(at(null, "2026-10-06T11:00:00Z")).toBeNull();
  });

  it("names a delegate whose part was taken back (they no longer have a row) from the event that handed it to them", () => {
    const at = nameResolver([], [{ type: "part_forwarded", signer_id: "m", created_at: "2026-10-06T08:00:00Z", detail: { delegate: "d1", to_name: "Siti" } }]);
    expect(at("d1", "2026-10-06T08:30:00Z")).toBe("Siti");
    expect(at("unknown", "2026-10-06T08:30:00Z")).toBeNull();
  });
});
