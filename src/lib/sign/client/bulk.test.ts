import { describe, expect, it } from "vitest";

import { BULK_MAX_BYTES } from "../bulk/types";
import { EMPTY_FORM, buildRequest, checkFile, fixedSignersOf, isFinalJob, nextPollMs, personComplete, pickDefaultRole, progressPercent, rowMatches, sampleCsv, setupProblems, stepDone, type WizardForm } from "./bulk";
import { allState, toggleId, toggleMany } from "./selection";

const roles = [
  { key: "merchant", label: "Merchant", kind: "signer" as const, needsPerson: true },
  { key: "director", label: "Director", kind: "signer" as const, needsPerson: true },
  { key: "witness", label: "Witness", kind: "filler" as const, needsPerson: false },
];
const person = { fullName: "Gokula", email: "gokula@vircle.example", phone: "", channel: "email" as const };
const form = (over: Partial<WizardForm> = {}): WizardForm => ({ ...EMPTY_FORM, templateId: "t1", personRole: "merchant", csvText: "full_name,email\r\nAli,ali@example.com\r\n", fileName: "list.csv", fixed: { director: person }, ...over });

describe("the request", () => {
  it("is the same shape for the preview and the start: options, the list, and whether to skip people with a problem", () => {
    const body = buildRequest(form(), roles);
    expect(body).toEqual({
      options: {
        templateId: "t1",
        personRole: "merchant",
        fixedSigners: [{ roleKey: "director", fullName: "Gokula", email: "gokula@vircle.example", phone: null, channel: "email" }],
        channel: "email",
        title: null,
        categoryId: null,
        message: null,
        locale: null,
        expiryDays: null,
        codeRequired: null,
        signInOrder: null,
        reminderDays: null,
      },
      csv: "full_name,email\r\nAli,ali@example.com\r\n",
      skipInvalid: false,
      fileName: "list.csv",
    });
  });

  it("sends the sender's choices, and leaves every default to the server", () => {
    const body = buildRequest(form({ title: " For {name} ", message: " Hi ", locale: "ms", expiryDays: "30", codeRequired: "yes", signInOrder: "no", reminderText: "3, 7", categoryId: "c1", skipInvalid: true }), roles)!;
    expect(body.options).toMatchObject({ title: "For {name}", message: "Hi", locale: "ms", expiryDays: 30, codeRequired: true, signInOrder: false, reminderDays: [3, 7], categoryId: "c1" });
    expect(body.skipInvalid).toBe(true);
    // "0" is no reminders at all, an untouched field is the default
    expect(buildRequest(form({ reminderText: "0" }), roles)!.options.reminderDays).toEqual([]);
    expect(buildRequest(form({ reminderText: null }), roles)!.options.reminderDays).toBeNull();
  });

  it("sends contacts by id, and no file", () => {
    const body = buildRequest(form({ source: "contacts", csvText: null, fileName: null, contacts: [{ id: "c1", name: "A", email: "a@example.com" }, { id: "c2", name: null, email: null }] }), roles)!;
    expect(body.contactIds).toEqual(["c1", "c2"]);
    expect(body.csv).toBeUndefined();
  });

  it("is not made while the template, the role or the list is missing", () => {
    expect(buildRequest(form({ templateId: null }), roles)).toBeNull();
    expect(buildRequest(form({ personRole: null }), roles)).toBeNull();
    expect(buildRequest(form({ csvText: null }), roles)).toBeNull();
    expect(buildRequest(form({ source: "contacts", contacts: [] }), roles)).toBeNull();
  });

  it("names the people of the other roles only when the sender started on them, and never the list's own role", () => {
    expect(fixedSignersOf(form({ fixed: { director: person, witness: { fullName: "", email: "", phone: "", channel: "email" }, merchant: person } }), roles).map((f) => f.roleKey)).toEqual(["director"]);
    expect(fixedSignersOf(form({ fixed: { witness: { ...person, channel: "whatsapp", phone: " +60 12 " } } }), roles)).toEqual([{ roleKey: "witness", fullName: "Gokula", email: "gokula@vircle.example", phone: "+60 12", channel: "whatsapp" }]);
  });
});

describe("the steps", () => {
  it("find what is wrong with the setup", () => {
    expect(setupProblems(form(), roles)).toEqual([]);
    expect(setupProblems(form({ personRole: null }), roles)).toContain("personRole");
    expect(setupProblems(form({ personRole: "ghost" }), roles)).toContain("personRole");
    // a role that needs a person
    expect(setupProblems(form({ fixed: {} }), roles)).toEqual(["fixed:director"]);
    // an optional role, once started, must be complete
    expect(setupProblems(form({ fixed: { director: person, witness: { ...person, email: "nope" } } }), roles)).toEqual(["fixed:witness"]);
    expect(setupProblems(form({ fixed: { director: { ...person, channel: "whatsapp", phone: "123" } } }), roles)).toEqual(["fixed:director"]);
    expect(setupProblems(form({ fixed: { director: { ...person, channel: "whatsapp", phone: "+60123456789" } } }), roles)).toEqual([]);
    expect(setupProblems(form({ expiryDays: "0" }), roles)).toEqual(["expiryDays"]);
    expect(setupProblems(form({ expiryDays: "366" }), roles)).toEqual(["expiryDays"]);
    expect(setupProblems(form({ expiryDays: "2.5" }), roles)).toEqual(["expiryDays"]);
    expect(setupProblems(form({ expiryDays: "30" }), roles)).toEqual([]);
    expect(setupProblems(form({ reminderText: "3, 7" }), roles)).toEqual([]);
    expect(setupProblems(form({ reminderText: "0" }), roles)).toEqual([]);
    expect(setupProblems(form({ reminderText: "3, 99" }), roles)).toEqual(["reminders"]);
    expect(setupProblems(form({ reminderText: "1,2,3,4,5,6" }), roles)).toEqual(["reminders"]);
    expect(setupProblems(form({ message: "m".repeat(2001), title: "t".repeat(201) }), roles)).toEqual(["message", "title"]);
  });

  it("know when each is complete", () => {
    expect(stepDone("template", EMPTY_FORM, roles)).toBe(false);
    expect(stepDone("template", form(), roles)).toBe(true);
    expect(stepDone("people", form(), roles)).toBe(true);
    expect(stepDone("people", form({ csvText: null }), roles)).toBe(false);
    expect(stepDone("people", form({ source: "contacts", contacts: [] }), roles)).toBe(false);
    expect(stepDone("setup", form(), roles)).toBe(true);
    expect(stepDone("setup", form({ fixed: {} }), roles)).toBe(false);
    expect(stepDone("review", form(), roles)).toBe(false);
  });

  it("recognise a complete person", () => {
    expect(personComplete(person)).toBe(true);
    expect(personComplete({ ...person, fullName: " " })).toBe(false);
    expect(personComplete(undefined)).toBe(false);
  });

  it("choose the role the list most likely fills", () => {
    expect(pickDefaultRole(roles)).toBe("merchant");
    expect(pickDefaultRole([{ key: "a", label: "A", kind: "filler", needsPerson: true }, { key: "b", label: "B", kind: "signer", needsPerson: true }])).toBe("b");
    expect(pickDefaultRole([{ key: "a", label: "A", kind: "filler", needsPerson: false }])).toBe("a");
    expect(pickDefaultRole([])).toBeNull();
  });
});

describe("the file", () => {
  it("is looked at before it is read", () => {
    expect(checkFile({ name: "list.csv", size: 1000 })).toBeNull();
    expect(checkFile({ name: "LIST.CSV", size: 1000 })).toBeNull();
    expect(checkFile({ name: "list", size: 10, type: "text/csv" })).toBeNull();
    expect(checkFile({ name: "list.xlsx", size: 10, type: "application/vnd.ms-excel" })).toBe("not_csv");
    expect(checkFile({ name: "list.csv", size: BULK_MAX_BYTES + 1 })).toBe("too_large");
    expect(checkFile({ name: "list.csv", size: BULK_MAX_BYTES })).toBeNull();
  });

  it("has a sample with the template's columns", () => {
    expect(sampleCsv(["business_name", "email", "fee"])).toEqual([
      ["full_name", "email", "phone", "business_name", "fee"],
      ["Ali bin Ahmad", "ali@example.com", "+60123456789", "", ""],
    ]);
    expect(sampleCsv([])[0]).toEqual(["full_name", "email", "phone"]);
  });
});

describe("a running batch", () => {
  const job = { total: 8, sent: 3, failed: 1, skipped: 1 };

  it("shows how far it is, from the people with an answer", () => {
    expect(progressPercent(job)).toBe(63);
    expect(progressPercent({ total: 4, sent: 4, failed: 0, skipped: 0 })).toBe(100);
    expect(progressPercent({ total: 0, sent: 0, failed: 0, skipped: 0 })).toBe(0);
    expect(progressPercent({ total: 2, sent: 5, failed: 0, skipped: 0 })).toBe(100);
  });

  it("is asked again soon while it runs, later while it waits, slower after failures, and not at all once finished", () => {
    expect(nextPollMs("running")).toBe(3000);
    expect(nextPollMs("queued")).toBe(5000);
    expect(nextPollMs("running", 1)).toBe(6000);
    expect(nextPollMs("running", 9)).toBe(24_000);
    expect(nextPollMs("queued", 9)).toBe(30_000);
    for (const s of ["done", "failed", "cancelled"] as const) {
      expect(nextPollMs(s)).toBeNull();
      expect(isFinalJob(s)).toBe(true);
    }
    expect(isFinalJob("running")).toBe(false);
  });

  it("filters its people by what became of them", () => {
    expect(rowMatches("sent", "all")).toBe(true);
    expect(rowMatches("failed", "failed")).toBe(true);
    expect(rowMatches("failed", "sent")).toBe(false);
    expect(rowMatches("pending", "pending")).toBe(true);
  });
});

describe("the ticked documents", () => {
  it("tick and untick one, up to the limit", () => {
    expect(toggleId([], "a", 2)).toEqual(["a"]);
    expect(toggleId(["a"], "b", 2)).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "c", 2)).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "a", 2)).toEqual(["b"]);
  });

  it("tick all that are on the screen as far as they fit, or untick them", () => {
    expect(toggleMany(["x"], ["a", "b", "c"], true, 3)).toEqual(["x", "a", "b"]);
    expect(toggleMany(["a"], ["a", "b"], true, 5)).toEqual(["a", "b"]);
    expect(toggleMany(["x", "a", "b"], ["a", "b"], false, 5)).toEqual(["x"]);
  });

  it("say how the all box looks", () => {
    expect(allState([], ["a", "b"])).toBe("none");
    expect(allState(["a"], ["a", "b"])).toBe("some");
    expect(allState(["a", "b", "z"], ["a", "b"])).toBe("all");
    expect(allState(["a"], [])).toBe("none");
  });
});
