import { describe, expect, it } from "vitest";

import type { SignRole, SignSignerRow } from "../types";
import { asHaloUser, asOutsidePerson, emptyRow, payloadKey, pickableMembers, rowIsComplete, rowsFromSigners, toPayload, updateRow, type HaloMember, type SignerRow } from "./signers-form";

// A Halo user on the signing list (a countersigner): chosen from the workspace's members, carried through the saved list and
// back, never offered twice, and let go again.

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
];
const members: HaloMember[] = [
  { user_id: "u-gokula", full_name: "Gokula Krishnan", email: "gokula@vircle.example" },
  { user_id: "u-siti", full_name: "Siti Aminah", email: "siti@vircle.example" },
  { user_id: "u-lim", full_name: "", email: "lim@vircle.example" },
];

describe("choosing a Halo user for a row", () => {
  it("fills the name and email from the member, keeps the role and step, and sets the link", () => {
    const row: SignerRow = { ...emptyRow("director", 2), fullName: "typed", email: "typed@x.example", phone: "+60123456789", channel: "whatsapp" };
    const next = updateRow([row], row.key, asHaloUser(members[0]))[0];
    expect(next).toMatchObject({ fullName: "Gokula Krishnan", email: "gokula@vircle.example", phone: "", channel: "email", internalUserId: "u-gokula", roleKey: "director", step: 2, key: row.key });
    expect(rowIsComplete(next, roles)).toBe(true);
  });

  it("falls back to the email when the member has no name", () => {
    expect(asHaloUser(members[2])).toMatchObject({ fullName: "lim@vircle.example", internalUserId: "u-lim" });
  });

  it("can be let go: the person stays as typed values, without the link", () => {
    const row = updateRow([emptyRow("merchant")], "x", {})[0];
    const halo = { ...row, ...asHaloUser(members[1]) };
    const free = { ...halo, ...asOutsidePerson };
    expect(free.internalUserId).toBeNull();
    expect(free.fullName).toBe("Siti Aminah");
    expect(toPayload([free], roles)[0]).not.toHaveProperty("internalUserId");
  });
});

describe("the saved list", () => {
  it("sends internalUserId for a Halo user and nothing for anyone else", () => {
    const halo = { ...emptyRow("director", 2), ...asHaloUser(members[0]) };
    const outside: SignerRow = { ...emptyRow("merchant", 1), fullName: "Ali", email: "ali@example.com" };
    const payload = toPayload([outside, halo], roles);
    expect(payload[0]).not.toHaveProperty("internalUserId");
    expect(payload[1].internalUserId).toBe("u-gokula");
  });

  it("makes a different save key when only the Halo link changes", () => {
    const base: SignerRow = { ...emptyRow("director"), fullName: "Gokula Krishnan", email: "gokula@vircle.example" };
    expect(payloadKey(toPayload([base], roles))).not.toBe(payloadKey(toPayload([{ ...base, internalUserId: "u-gokula" }], roles)));
  });

  it("comes back from the saved people with the link", () => {
    const saved = [
      { id: "s1", role_key: "director", full_name: "Gokula Krishnan", email: "gokula@vircle.example", phone: null, channel: "email", order_no: 1, internal_user_id: "u-gokula", created_at: "2026-10-06T09:04:00Z" },
      { id: "s2", role_key: "merchant", full_name: "Ali", email: "ali@example.com", phone: null, channel: "email", order_no: 2, internal_user_id: null, created_at: "2026-10-06T09:05:00Z" },
    ] as unknown as SignSignerRow[];
    const rows = rowsFromSigners(saved);
    expect(rows[0].internalUserId).toBe("u-gokula");
    expect(rows[1].internalUserId ?? null).toBeNull();
  });
});

describe("who can be picked", () => {
  it("leaves out a member already on the list as a Halo user", () => {
    const rows = [{ ...emptyRow("director"), ...asHaloUser(members[0]) }];
    expect(pickableMembers(members, rows, "").map((m) => m.user_id)).toEqual(["u-siti", "u-lim"]);
  });

  it("matches the name or the email, any case, ignoring spaces around the search", () => {
    expect(pickableMembers(members, [], "  SITI ").map((m) => m.user_id)).toEqual(["u-siti"]);
    expect(pickableMembers(members, [], "lim@").map((m) => m.user_id)).toEqual(["u-lim"]);
    expect(pickableMembers(members, [], "nobody")).toEqual([]);
  });

  it("still offers a person who is on the list as an outside person with the same email", () => {
    const rows: SignerRow[] = [{ ...emptyRow("merchant"), fullName: "Gokula", email: "gokula@vircle.example" }];
    expect(pickableMembers(members, rows, "").map((m) => m.user_id)).toContain("u-gokula");
  });
});
