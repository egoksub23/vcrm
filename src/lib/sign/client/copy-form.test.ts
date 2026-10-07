import { describe, expect, it } from "vitest";

import { MAX_COPY_RECIPIENTS } from "../envelopes";
import { MAX_SIGNERS } from "../rules";
import {
  addCopy,
  canAddCopy,
  copiesFromRecords,
  copyFlags,
  copyHasInput,
  copyIsComplete,
  copyKey,
  copyNotices,
  copyPayload,
  copyToSigner,
  emptyCopy,
  fillFromContact,
  removeCopy,
  signerToCopy,
  updateCopy,
} from "./copy-form";
import { emptyRow, toPayload, type SignerRow } from "./signers-form";
import type { SignRole } from "../types";

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
];
const signer = (name: string, email: string, roleKey = "merchant", step = 1): SignerRow => ({ ...emptyRow(roleKey, step), fullName: name, email });

describe("the copy list", () => {
  it("starts from the saved people, in order, with keys of their own", () => {
    const list = copiesFromRecords([
      { full_name: "Mei", email: "mei@example.com" },
      { full_name: "Raj", email: "raj@example.com" },
    ]);
    expect(list.map((c) => [c.fullName, c.email])).toEqual([
      ["Mei", "mei@example.com"],
      ["Raj", "raj@example.com"],
    ]);
    expect(new Set(list.map((c) => c.key)).size).toBe(2);
    expect(copiesFromRecords()).toEqual([]);
  });

  it("adds, updates and removes people without touching the others", () => {
    let list = addCopy([], { fullName: "Mei" });
    list = addCopy(list, { fullName: "Raj", email: "raj@example.com" });
    expect(list.map((c) => c.fullName)).toEqual(["Mei", "Raj"]);
    list = updateCopy(list, list[0].key, { email: "mei@example.com" });
    expect(list[0].email).toBe("mei@example.com");
    expect(list[1].email).toBe("raj@example.com");
    list = removeCopy(list, list[0].key);
    expect(list.map((c) => c.fullName)).toEqual(["Raj"]);
    expect(removeCopy(list, "nobody")).toHaveLength(1);
  });

  it("stops adding at ten", () => {
    let list = [] as ReturnType<typeof addCopy>;
    for (let i = 0; i < MAX_COPY_RECIPIENTS + 3; i++) list = addCopy(list, { fullName: `P${i}`, email: `p${i}@example.com` });
    expect(list).toHaveLength(MAX_COPY_RECIPIENTS);
    expect(canAddCopy(list)).toBe(false);
    expect(canAddCopy(list.slice(1))).toBe(true);
  });
});

describe("what is wrong with a person who receives a copy", () => {
  it("needs a name of at most 160 characters and a valid address of at most 254", () => {
    expect(copyIsComplete({ fullName: "Mei", email: "mei@example.com" })).toBe(true);
    expect(copyFlags({ fullName: " ", email: "mei@example.com" })).toEqual({ name: true, email: false });
    expect(copyFlags({ fullName: "Mei", email: "mei@" })).toEqual({ name: false, email: true });
    expect(copyFlags({ fullName: "x".repeat(161), email: "a@b.co" }).name).toBe(true);
    expect(copyFlags({ fullName: "x".repeat(160), email: "a@b.co" }).name).toBe(false);
    expect(copyFlags({ fullName: "Mei", email: `${"a".repeat(250)}@b.co` }).email).toBe(true);
  });

  it("calls a blank person untouched and a half-typed one input", () => {
    expect(copyHasInput(emptyCopy())).toBe(false);
    expect(copyHasInput(emptyCopy({ fullName: "Me" }))).toBe(true);
    expect(copyHasInput(emptyCopy({ email: "m" }))).toBe(true);
  });
});

describe("the payload", () => {
  const c = (fullName: string, email: string) => emptyCopy({ fullName, email });

  it("holds only the complete people, trimmed, in order", () => {
    const payload = copyPayload([c(" Mei ", " mei@example.com "), c("", "x@example.com"), c("Raj", "nope"), c("Sam", "sam@example.com")]);
    expect(payload).toEqual([
      { fullName: "Mei", email: "mei@example.com" },
      { fullName: "Sam", email: "sam@example.com" },
    ]);
  });

  it("keeps each address once, whatever the case, the first one listed", () => {
    const payload = copyPayload([c("Mei", "mei@example.com"), c("Mei again", " MEI@Example.com "), c("Raj", "raj@example.com")]);
    expect(payload.map((p) => p.fullName)).toEqual(["Mei", "Raj"]);
  });

  it("leaves out an address that also signs", () => {
    const payload = copyPayload([c("Ali", "ALI@example.com"), c("Mei", "mei@example.com")], ["ali@example.com", ""]);
    expect(payload.map((p) => p.fullName)).toEqual(["Mei"]);
  });

  it("holds at most ten", () => {
    const many = Array.from({ length: 14 }, (_, i) => c(`P${i}`, `p${i}@example.com`));
    expect(copyPayload(many)).toHaveLength(MAX_COPY_RECIPIENTS);
  });

  it("gives the same key for lists the server would store the same, and a different one when a name or address changes", () => {
    const a = copyPayload([c("Mei", "mei@example.com")]);
    const b = copyPayload([c(" Mei", "mei@example.com ")]);
    expect(copyKey(a)).toBe(copyKey(b));
    expect(copyKey(a)).not.toBe(copyKey(copyPayload([c("Mei", "mei2@example.com")])));
    expect(copyKey([])).toBe("[]");
  });
});

describe("notices", () => {
  const c = (fullName: string, email: string) => emptyCopy({ fullName, email });

  it("names an address listed twice on each row that shares it, with the 1-based numbers, like the signers' notice", () => {
    const list = [c("Mei", "mei@example.com"), c("Raj", "raj@example.com"), c("Mei 2", " MEI@example.com")];
    const notices = copyNotices(list, []);
    expect(notices.map((n) => [n.index, n.kind, n.positions])).toEqual([
      [0, "duplicate", [1, 3]],
      [2, "duplicate", [1, 3]],
    ]);
    expect(notices[0].email).toBe("mei@example.com");
  });

  it("names an address that also signs", () => {
    const notices = copyNotices([c("Ali", "ali@example.com"), c("Mei", "mei@example.com")], ["Ali@Example.com"]);
    expect(notices).toEqual([{ index: 0, kind: "signer", email: "ali@example.com", positions: [] }]);
  });

  it("says nothing about blank rows or a clean list", () => {
    expect(copyNotices([c("", ""), c("Mei", "mei@example.com")], ["ali@example.com"])).toEqual([]);
  });
});

describe("choosing a contact", () => {
  it("fills the name and the email", () => {
    expect(fillFromContact({ name: " Mei Lin ", email: "mei@example.com" }, { fullName: "Me", email: "" })).toEqual({ fullName: "Mei Lin", email: "mei@example.com" });
  });

  it("leaves the typed email alone when the contact has none, and the typed name when the contact has none", () => {
    expect(fillFromContact({ name: "Mei Lin", email: null }, { fullName: "Me", email: "typed@example.com" })).toEqual({ fullName: "Mei Lin", email: "typed@example.com" });
    expect(fillFromContact({ name: null, email: "mei@example.com" }, { fullName: "Me", email: "" })).toEqual({ fullName: "Me", email: "mei@example.com" });
    expect(fillFromContact({ name: "  ", email: " " }, { fullName: "Me", email: "m@x.co" })).toEqual({ fullName: "Me", email: "m@x.co" });
  });
});

describe("changing a person's type", () => {
  it("moves a signer to the copy list with name and email, and out of the signing payload", () => {
    const rows = [signer("Ali", "ali@example.com"), signer("Siti", "siti@example.com", "director", 2)];
    const moved = signerToCopy(rows, [], rows[1].key);
    expect(moved.rows.map((r) => r.fullName)).toEqual(["Ali"]);
    expect(moved.copies.map((p) => [p.fullName, p.email])).toEqual([["Siti", "siti@example.com"]]);
    // the signing payload never carries a copy person
    expect(toPayload(moved.rows, roles).map((p) => p.email)).toEqual(["ali@example.com"]);
  });

  it("moves a copy person to the signing list in a step of their own, with name and email", () => {
    const rows = [signer("Ali", "ali@example.com")];
    const copies = [emptyCopy({ fullName: "Mei", email: "mei@example.com" }), emptyCopy({ fullName: "Raj", email: "raj@example.com" })];
    const moved = copyToSigner(rows, copies, roles, copies[0].key);
    expect(moved.copies.map((p) => p.fullName)).toEqual(["Raj"]);
    expect(moved.rows.map((r) => r.fullName)).toEqual(["Ali", "Mei"]);
    expect(moved.rows[1]).toMatchObject({ email: "mei@example.com", step: 2, roleKey: "director", channel: "email" });
  });

  it("loses nothing going to copy and back", () => {
    const rows = [signer("Ali", "ali@example.com")];
    const there = signerToCopy(rows, [], rows[0].key);
    const back = copyToSigner(there.rows, there.copies, roles, there.copies[0].key);
    expect(back.rows.map((r) => [r.fullName, r.email])).toEqual([["Ali", "ali@example.com"]]);
    expect(back.copies).toEqual([]);
  });

  it("moves a half-typed person too", () => {
    const rows = [signer("", "")];
    const moved = signerToCopy(rows, [], rows[0].key);
    expect(moved.rows).toEqual([]);
    expect(moved.copies).toHaveLength(1);
    expect(copyHasInput(moved.copies[0])).toBe(false);
  });

  it("moves nobody when the other list is full", () => {
    const full = Array.from({ length: MAX_COPY_RECIPIENTS }, (_, i) => emptyCopy({ fullName: `P${i}`, email: `p${i}@example.com` }));
    const rows = [signer("Ali", "ali@example.com")];
    const a = signerToCopy(rows, full, rows[0].key);
    expect(a.rows).toHaveLength(1);
    expect(a.copies).toHaveLength(MAX_COPY_RECIPIENTS);

    const many = Array.from({ length: MAX_SIGNERS }, (_, i) => signer(`S${i}`, `s${i}@example.com`, "merchant", i + 1));
    const copies = [emptyCopy({ fullName: "Mei", email: "mei@example.com" })];
    const b = copyToSigner(many, copies, roles, copies[0].key);
    expect(b.rows).toHaveLength(MAX_SIGNERS);
    expect(b.copies).toHaveLength(1);
  });

  it("ignores a key that is not on the list", () => {
    const rows = [signer("Ali", "ali@example.com")];
    expect(signerToCopy(rows, [], "ghost").rows).toHaveLength(1);
    expect(copyToSigner(rows, [], roles, "ghost").rows).toHaveLength(1);
  });
});
