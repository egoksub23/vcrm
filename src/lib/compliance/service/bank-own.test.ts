/* eslint-disable @typescript-eslint/no-explicit-any -- rows and bodies are read loosely in a test */
// The staff flag "the bank holder name differs from the account holder name" (migration 186) as createComplianceRequest and editRequest write it, against the
// in-memory database with the closure type as migration 186 leaves it (the question before the bank details, the letter asked after a No). The flag is
// computed on the server from the answer and the two names, stored as a plain true or false in the case's ordinary data (no name in it), and kept in step when
// an edit changes the answer, the bank holder name or the account holder name. The public and personal forms' own flows are tested next to them.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeDb } from "@/lib/sign/service/fake-db";

import { ACCOUNT, ACCOUNT_NUMBER, CLOSURE_ANSWERS, CLOSURE_FIELDS, OFFICER, head, officer, world, withBankOwn } from "../test-support";
import { createComplianceRequest, editRequest } from "./write";

let db: FakeDb;
let admin: ReturnType<FakeDb["client"]>;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = world();
  for (const t of db.rows("compliance_request_types") as any[]) if (t.key === "closure") t.fields = withBankOwn(CLOSURE_FIELDS);
  admin = db.client();
});

const create = (over: Record<string, unknown> = {}, answers: Record<string, unknown> = {}) =>
  createComplianceRequest(admin, { accountId: ACCOUNT, typeKey: "closure", source: "staff", customerName: "Siti Aminah", customerPhone: "012-345 6789", answers: { ...CLOSURE_ANSWERS, ...answers }, createdBy: OFFICER, ...over } as any);
const theCase = () => db.rows("compliance_requests")[0] as any;

describe("the flag written when a case is made", () => {
  it("is true for a Yes whose names differ, and holds no name", async () => {
    await create({}, { bank_account_holder: "Ahmad Yusof" });
    expect(theCase().data).toMatchObject({ bank_account_is_own: true, name_differs: true });
    expect(JSON.stringify(theCase().data)).not.toMatch(/Ahmad|Siti/);
    expect(JSON.stringify(theCase().data)).not.toContain(ACCOUNT_NUMBER);
  });

  it("is false for the same person written another way", async () => {
    await create({ customerName: "Gokula Krishnan Subramaniam" }, { bank_account_holder: "Gokula Krishnan a/l Subramaniam" });
    expect(theCase().data).toMatchObject({ bank_account_is_own: true, name_differs: false });
  });

  it("is false for a No (a letter is on file instead) and absent when the question was not answered or there is no holder name", async () => {
    await create({}, { bank_account_is_own: false, bank_account_holder: "Ahmad Yusof" });
    expect(theCase().data).toMatchObject({ bank_account_is_own: false, name_differs: false });
    db.tables.compliance_requests = [];
    await create({ answersPartial: true }, { bank_account_is_own: undefined, bank_account_holder: "Ahmad Yusof" });
    expect("name_differs" in theCase().data).toBe(false);
    expect("bank_account_is_own" in theCase().data).toBe(false);
    db.tables.compliance_requests = [];
    await create({ answersPartial: true }, { bank_account_holder: undefined });
    expect(theCase().data.bank_account_is_own).toBe(true);
    expect("name_differs" in theCase().data).toBe(false);
  });

  it("is written by the server only: a flag typed into the answers is ignored", async () => {
    await create({}, { name_differs: true, bank_account_holder: "Siti Aminah" });
    expect(theCase().data.name_differs).toBe(false);
  });

  it("makes a case on a type that does not carry the question exactly as before", async () => {
    for (const t of db.rows("compliance_request_types") as any[]) if (t.key === "closure") t.fields = CLOSURE_FIELDS;
    await create({}, { bank_account_holder: "Ahmad Yusof" });
    expect(theCase().data).toEqual({ confirm_closure: true, children_finished_school: true, allowances_cancelled: true, reason: "Moving abroad" });
  });

  it("makes a case on the new type that requires the answer: staff must give it when they give the bank details", async () => {
    const { ComplianceError } = await import("../errors");
    const fails = await createComplianceRequest(admin, { accountId: ACCOUNT, typeKey: "closure", source: "staff", customerName: "Siti Aminah", answers: { ...CLOSURE_ANSWERS, bank_account_is_own: undefined } } as any).then(() => null, (e) => e);
    expect(fails).toBeInstanceOf(ComplianceError);
    expect(fails).toMatchObject({ code: "validation_failed", issues: [{ field: "bank_account_is_own", code: "required" }] });
    expect(db.rows("compliance_requests")).toHaveLength(0);
  });
});

describe("the flag kept in step by an edit", () => {
  let patches: any[];
  beforeEach(() => {
    patches = [];
    db.rpcHandlers.compliance_update_request = (args) => {
      patches.push(args.p_patch);
      return { data: { id: args.p_request, changed: Object.keys(args.p_patch as object) }, error: null };
    };
  });

  it("is recomputed when the bank holder name is changed", async () => {
    const { id } = await create({}, { bank_account_holder: "Siti Aminah" });
    expect(theCase().data.name_differs).toBe(false);
    await editRequest(admin, head(), id, { sensitive: { bank_account_holder: "Ahmad Yusof" } });
    expect(patches[0].data).toMatchObject({ bank_account_is_own: true, name_differs: true });
    // and back
    theCase().data = patches[0].data;
    await editRequest(admin, head(), id, { sensitive: { bank_account_holder: "SITI AMINAH" } });
    expect(patches[1].data.name_differs).toBe(false);
  });

  it("is recomputed when the account holder name is changed, and when the answer is changed to No", async () => {
    const { id } = await create({}, { bank_account_holder: "Ahmad Yusof" });
    expect(theCase().data.name_differs).toBe(true);
    await editRequest(admin, officer(), id, { customerName: "Ahmad Yusof" });
    expect(patches[0].data.name_differs).toBe(false);
    expect(patches[0].customer_name).toBe("Ahmad Yusof");
    theCase().data = { ...theCase().data, name_differs: true };
    await editRequest(admin, officer(), id, { answers: { bank_account_is_own: false } });
    expect(patches[1].data).toMatchObject({ bank_account_is_own: false, name_differs: false });
  });

  it("leaves the flag alone for an edit that touches none of the three", async () => {
    const { id } = await create({}, { bank_account_holder: "Ahmad Yusof" });
    await editRequest(admin, officer(), id, { answers: { reason: "Changed my mind" } });
    expect(patches[0].data.reason).toBe("Changed my mind");
    expect(patches[0].data.name_differs).toBe(true);
    patches.length = 0;
    await editRequest(admin, officer(), id, { customerPhone: "019-876 5432" });
    expect(patches[0].data).toBeUndefined();
  });
});
