import { describe, expect, it } from "vitest";

import type { EnvelopeDocLite, EnvelopePerson } from "../envelopes";
import { parsePeople } from "../service/people-input";
import { addAlternate, alternateIsComplete, liveEnvelopeIssues, peoplePayload, personIsComplete, removeAlternate, setPersonType, updateAlternate, updatePerson } from "./envelope-form";
import { KNOWN_ERROR_CODES, errorKey } from "./errors";
import { signerBadgeClass, signerProgress, signerStatusKey, waitingSummary } from "./status";

// The browser side of someone who can sign instead of a person (migration 187): adding, editing and removing one on the People step, what is saved,
// how the progress and the words about the people read, and the failure codes the screens word.

const DOC: EnvelopeDocLite = { id: "u1", position: 1, title: "Upload", roles: [], fromTemplate: false };
const ali = (over: Partial<EnvelopePerson> = {}): EnvelopePerson => ({ key: "pp_ali00001", fullName: "Ali", email: "ali@kedai.example", phone: "", channel: "email", step: 1, roles: {}, ...over });
const bala = (over: Partial<EnvelopePerson> = {}): EnvelopePerson => ({ key: "pp_bala0002", fullName: "Bala", email: "bala@kedai.example", phone: "", channel: "email", step: 2, roles: {}, ...over });
const SITI = { fullName: "Siti Finance", email: "siti@kedai.example" };

describe("adding, changing and removing someone who can sign instead", () => {
  it("starts empty on a person who must sign, edits in place, and goes away with a click", () => {
    const people = addAlternate([ali(), bala()], "pp_ali00001");
    expect(people[0].alternate).toEqual({ fullName: "", email: "" });
    expect(people[1].alternate).toBeUndefined();
    const edited = updateAlternate(people, "pp_ali00001", { fullName: "Siti Finance" });
    expect(updateAlternate(edited, "pp_ali00001", { email: "siti@kedai.example" })[0].alternate).toEqual(SITI);
    expect(removeAlternate(edited, "pp_ali00001")[0].alternate).toBeUndefined();
    // adding again to a person who has one changes nothing; editing a person who has none changes nothing
    expect(addAlternate(edited, "pp_ali00001")[0].alternate).toEqual({ fullName: "Siti Finance", email: "" });
    expect(updateAlternate([ali()], "pp_ali00001", { fullName: "x" })[0].alternate).toBeUndefined();
  });

  it("is not for a person who receives a copy or a Halo user, and goes when the person becomes one", () => {
    const copy = ali({ type: "copy" });
    expect(addAlternate([copy], copy.key)[0].alternate).toBeUndefined();
    const halo = ali({ internalUserId: "u1" });
    expect(addAlternate([halo], halo.key)[0].alternate).toBeUndefined();
    // a person with someone who can sign instead becomes a copy, or a Halo user: the alternate is dropped
    expect(setPersonType([ali({ alternate: SITI })], "pp_ali00001", "copy", [DOC])[0].alternate).toBeUndefined();
    expect(updatePerson([ali({ alternate: SITI })], "pp_ali00001", { internalUserId: "u1" })[0].alternate).toBeUndefined();
    // a rename keeps it
    expect(updatePerson([ali({ alternate: SITI })], "pp_ali00001", { fullName: "Ali bin Ahmad" })[0].alternate).toEqual(SITI);
  });
});

describe("what is saved", () => {
  it("holds a person back until their alternate is finished, and sends it trimmed with the person", () => {
    expect(alternateIsComplete(SITI)).toBe(true);
    expect(alternateIsComplete({ fullName: "Siti", email: "" })).toBe(false);
    expect(personIsComplete(ali({ alternate: { fullName: "", email: "" } }), [DOC])).toBe(false);
    expect(personIsComplete(ali({ alternate: SITI }), [DOC])).toBe(true);
    const sent = peoplePayload([ali({ alternate: { fullName: " Siti Finance ", email: " siti@kedai.example " } }), bala()], [DOC], false);
    expect(sent[0].alternate).toEqual(SITI);
    expect(sent[1].alternate).toBeUndefined();
    // a half typed alternate keeps the person out of the saved list (still being filled in), without losing their role
    const unfinished = peoplePayload([ali({ alternate: { fullName: "Siti", email: "siti@" } })], [DOC], false);
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]).toMatchObject({ incomplete: true });
    expect(unfinished[0].alternate).toBeUndefined();
  });

  it("is read by the route the way the screen wrote it, and anything that is not a name and an address is read as an empty one", () => {
    const [a, b, c] = parsePeople([{ fullName: "Ali", email: "ali@kedai.example", alternate: { fullName: "Siti Finance", email: "siti@kedai.example" } }, { fullName: "Bala", email: "bala@kedai.example", alternate: "nobody" }, { fullName: "Cara", email: "cara@kedai.example", alternate: { fullName: 3 } }]);
    expect(a.alternate).toEqual(SITI);
    expect(b.alternate).toBeUndefined();
    expect(c.alternate).toEqual({ fullName: "3", email: "" });
  });

  it("is checked live with the same rules as the server", () => {
    const codes = (people: EnvelopePerson[]) => liveEnvelopeIssues([DOC], people, false).map((i) => i.code);
    expect(codes([ali({ alternate: SITI }), bala()])).toEqual([]);
    expect(codes([ali({ alternate: { fullName: "", email: "x" } }), bala()])).toEqual(["alternate_name", "alternate_email"]);
  });
});

describe("the progress and the words about the people", () => {
  it("counts the two people of a role as one place, done when either has signed", () => {
    const rows = (a: string, b: string, c: string) => [
      { id: "p1", status: a },
      { id: "p2", status: b, alternate_of: "p1" },
      { id: "p3", status: c },
    ];
    expect(signerProgress(rows("sent", "sent", "sent"))).toEqual({ done: 0, total: 2 });
    expect(signerProgress(rows("not_needed", "signed", "sent"))).toEqual({ done: 1, total: 2 });
    expect(signerProgress(rows("signed", "not_needed", "signed"))).toEqual({ done: 2, total: 2 });
    // rows that do not say who they are (an older list) count one each
    expect(signerProgress([{ status: "signed" }, { status: "sent" }])).toEqual({ done: 1, total: 2 });
  });

  it("does not wait for a person who is not needed, and gives the status its word and a quiet colour", () => {
    const people = [{ full_name: "Siti", status: "signed", order_no: 1 }, { full_name: "Ali", status: "not_needed", order_no: 1 }, { full_name: "Bala", status: "sent", order_no: 2 }];
    expect(waitingSummary("in_progress", people)).toEqual({ names: ["Bala"], more: 0 });
    expect(signerStatusKey("not_needed")).toBe("status.signer.not_needed");
    expect(signerBadgeClass("not_needed")).toBe("bg-muted text-muted-foreground");
  });

  it("words the failures an alternate can meet", () => {
    for (const code of ["completed_by_other", "alternate_invalid", "alternate_same_person", "alternate_fixed", "alternate_needs_draft", "alternate_not_in_collection"]) {
      expect(KNOWN_ERROR_CODES, code).toContain(code);
      expect(errorKey(code)).toBe(`errors.${code}`);
    }
  });
});
