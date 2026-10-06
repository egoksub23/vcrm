import { describe, expect, it } from "vitest";

import type { PlacedField } from "../pdf/types";
import { sendProblems } from "../rules";
import type { SignRole, SignSignerRow } from "../types";
import {
  addRow,
  defaultRoleFor,
  duplicateEmails,
  emptyRow,
  moveRow,
  moveRowBy,
  payloadKey,
  removeRow,
  reviewLines,
  rolesWithoutPeople,
  rowFlags,
  rowHasInput,
  rowIsComplete,
  rowsForRoles,
  rowsFromSigners,
  toDrafts,
  toPayload,
  updateRow,
  type SignerRow,
} from "./signers-form";

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
  { key: "witness", label: "Witness", kind: "filler", color: 2 },
];

const row = (over: Partial<SignerRow> = {}): SignerRow => ({ ...emptyRow("merchant"), fullName: "Ali bin Ahmad", email: "ali@example.com", ...over });

describe("rows", () => {
  it("starts with one empty row for each role", () => {
    const rows = rowsForRoles(roles);
    expect(rows.map((r) => r.roleKey)).toEqual(["merchant", "director", "witness"]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it("gives a new row the first role with nobody on it, else the first", () => {
    expect(defaultRoleFor([row()], roles)).toBe("director");
    expect(defaultRoleFor(rowsForRoles(roles), roles)).toBe("merchant");
    expect(defaultRoleFor([], [])).toBe("");
  });

  it("adds, updates and removes without changing the original list", () => {
    const base = [row()];
    const added = addRow(base, roles, { fullName: "Siti" });
    expect(added).toHaveLength(2);
    expect(base).toHaveLength(1);
    expect(added[1]).toMatchObject({ fullName: "Siti", roleKey: "director" });
    const updated = updateRow(added, added[1].key, { email: "siti@example.com" });
    expect(updated[1].email).toBe("siti@example.com");
    expect(added[1].email).toBe("");
    expect(removeRow(updated, updated[0].key)).toHaveLength(1);
  });

  it("stops at 20 people", () => {
    let rows: SignerRow[] = [];
    for (let i = 0; i < 25; i++) rows = addRow(rows, roles);
    expect(rows).toHaveLength(20);
  });

  it("reads saved people back in signing order", () => {
    const saved = [
      { role_key: "director", full_name: "B", email: "b@x.com", phone: null, channel: "email", order_no: 2, created_at: "2026-01-01" },
      { role_key: "merchant", full_name: "A", email: "a@x.com", phone: "+60123456789", channel: "whatsapp", order_no: 1, created_at: "2026-01-02" },
    ] as unknown as SignSignerRow[];
    const rows = rowsFromSigners(saved);
    expect(rows.map((r) => r.fullName)).toEqual(["A", "B"]);
    expect(rows[0]).toMatchObject({ channel: "whatsapp", phone: "+60123456789" });
  });
});

describe("reordering", () => {
  const rows = [row({ fullName: "A" }), row({ fullName: "B" }), row({ fullName: "C" })];
  const names = (r: SignerRow[]) => r.map((x) => x.fullName).join("");

  it("moves a row to a position", () => {
    expect(names(moveRow(rows, 0, 2))).toBe("BCA");
    expect(names(moveRow(rows, 2, 0))).toBe("CAB");
  });

  it("clamps and ignores impossible moves", () => {
    expect(names(moveRow(rows, 1, 99))).toBe("ACB");
    expect(names(moveRow(rows, 1, -5))).toBe("BAC");
    expect(names(moveRow(rows, 7, 0))).toBe("ABC");
    expect(names(moveRow(rows, 1, 1))).toBe("ABC");
  });

  it("moves by one step with the arrows", () => {
    expect(names(moveRowBy(rows, rows[1].key, -1))).toBe("BAC");
    expect(names(moveRowBy(rows, rows[1].key, 1))).toBe("ACB");
    expect(names(moveRowBy(rows, rows[0].key, -1))).toBe("ABC");
    expect(names(moveRowBy(rows, "nope", 1))).toBe("ABC");
  });
});

describe("what is wrong with a row", () => {
  it("accepts a complete row", () => {
    expect(rowIsComplete(row(), roles)).toBe(true);
  });

  it("flags a missing name, a bad email and an unknown role", () => {
    expect(rowFlags(row({ fullName: "  " }), roles).name).toBe(true);
    expect(rowFlags(row({ email: "ali@" }), roles).email).toBe(true);
    expect(rowFlags(row({ roleKey: "gone" }), roles).role).toBe(true);
    expect(rowFlags(row({ roleKey: "" }), roles).role).toBe(true);
  });

  it("asks for a phone number only for WhatsApp, with a country code", () => {
    expect(rowFlags(row({ channel: "email", phone: "" }), roles).phone).toBe(false);
    expect(rowFlags(row({ channel: "whatsapp", phone: "" }), roles).phone).toBe(true);
    expect(rowFlags(row({ channel: "whatsapp", phone: "012 345 6789" }), roles).phone).toBe(true);
    expect(rowFlags(row({ channel: "whatsapp", phone: "+60 12-345 6789" }), roles).phone).toBe(false);
  });

  it("knows whether anything was typed", () => {
    expect(rowHasInput(emptyRow("merchant"))).toBe(false);
    expect(rowHasInput(row())).toBe(true);
  });
});

describe("what is saved", () => {
  it("sends only complete rows, numbered by position among them", () => {
    const rows = [row({ fullName: "A" }), row({ fullName: "", roleKey: "director" }), row({ fullName: "C", roleKey: "witness", email: "c@example.com" })];
    const payload = toPayload(rows, roles);
    expect(payload.map((p) => [p.fullName, p.orderNo, p.kind])).toEqual([
      ["A", 1, "signer"],
      ["C", 2, "filler"],
    ]);
  });

  it("normalises a WhatsApp number and keeps the email channel phone as typed", () => {
    const [wa] = toPayload([row({ channel: "whatsapp", phone: "+60 12-345 6789" })], roles);
    expect(wa.phone).toBe("+60123456789");
    const [em] = toPayload([row({ phone: " 012 " })], roles);
    expect(em.phone).toBe("012");
  });

  it("makes the same key for the same list, so an unchanged list is not saved again", () => {
    const a = toPayload([row()], roles);
    const b = toPayload([{ ...row(), key: "other" }], roles);
    expect(payloadKey(a)).toBe(payloadKey(b));
    expect(payloadKey(a)).not.toBe(payloadKey([]));
  });
});

describe("agreement with the server rules", () => {
  const fields: PlacedField[] = [
    { key: "f1", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05, required: true },
    { key: "f2", type: "signature", role: "director", page: 0, x: 0.1, y: 0.3, w: 0.2, h: 0.05, required: true },
  ];
  const check = (rows: SignerRow[], signInOrder: boolean) => sendProblems({ fields, roles, signers: toDrafts(rows, roles), signInOrder, pageCount: 1, hasBaseFile: true }).map((i) => i.code);

  it("finds no problem with a complete list", () => {
    expect(check([row(), row({ roleKey: "director", fullName: "Gokula", email: "g@example.com" })], true)).toEqual([]);
  });

  it("never produces the same order number twice, so order_not_unique cannot happen from this screen", () => {
    const rows = [row(), row({ roleKey: "director", fullName: "G", email: "g@example.com" })];
    const reordered = moveRow(rows, 0, 1);
    expect(toDrafts(reordered, roles).map((d) => d.order_no)).toEqual([1, 2]);
    expect(check(reordered, true)).not.toContain("order_not_unique");
  });

  it("finds the same person twice only when signing order is on", () => {
    const rows = [row(), row({ roleKey: "director", fullName: "Same", email: "ALI@example.com " })];
    expect(check(rows, true)).toContain("same_person_twice");
    expect(check(rows, false)).not.toContain("same_person_twice");
  });

  it("finds a role that has fields but nobody", () => {
    expect(check([row()], false)).toContain("role_without_person");
  });
});

describe("helpers for the screen", () => {
  it("finds an email on two rows, ignoring case and spaces", () => {
    const rows = [row({ email: "a@x.com" }), row({ email: " A@X.com" }), row({ email: "b@x.com" }), row({ email: "" }), row({ email: "" })];
    expect(duplicateEmails(rows)).toEqual([{ email: "a@x.com", positions: [1, 2] }]);
  });

  it("lists the roles nobody is on", () => {
    expect(rolesWithoutPeople([row()], roles).map((r) => r.key)).toEqual(["director", "witness"]);
  });

  it("describes the people to be invited, in order, with their role label", () => {
    const lines = reviewLines([row(), row({ roleKey: "witness", fullName: "W", email: "w@x.com", channel: "whatsapp", phone: "+60123456789" })], roles);
    expect(lines).toMatchObject([
      { position: 1, roleLabel: "Merchant", kind: "signer", channel: "email" },
      { position: 2, roleLabel: "Witness", kind: "filler", channel: "whatsapp", phone: "+60123456789" },
    ]);
  });
});
