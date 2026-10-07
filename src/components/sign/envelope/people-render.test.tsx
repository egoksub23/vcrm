import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The People step of a draft collection and the people of a sent one, in every language with the real wording (next-intl throws on a missing
// key). The name box is replaced by a stand-in that records what the screen gave it, so the wiring of "choose a contact" is exercised without a DOM.

const hoisted = vi.hoisted(() => ({ can: { value: true }, nameBoxes: [] as { id?: string; value: string; onChange: (v: string) => void; onPickContact: (c: Record<string, unknown>) => void }[] }));

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "acc-1" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/hooks/use-can", () => ({ useCapability: () => hoisted.can.value }));
vi.mock("../send/person-name-input", () => ({
  PersonNameInput: (p: { id?: string; value: string; onChange: (v: string) => void; onPickContact: (c: Record<string, unknown>) => void }) => {
    hoisted.nameBoxes.push(p);
    return <input data-name-box id={p.id} role="combobox" aria-controls="x" aria-expanded={false} defaultValue={p.value} />;
  },
}));

import type { EnvelopeData } from "@/hooks/use-sign-envelope";
import { addPerson, setPersonType } from "@/lib/sign/client/envelope-form";
import type { EnvelopeDocLite, EnvelopePerson } from "@/lib/sign/envelopes";
import type { SignCopyRecipientRow, SignEnvelopeRow } from "@/lib/sign/types";
import { EnvelopeDetail } from "./envelope-detail";
import { ProcessPeople as EnvelopePeople, RemovalWords } from "../process/people-step";
import { applyContact, removalAsk } from "./people-edit";

type Tree = Record<string, unknown>;
const LOCALES = ["en", "ms", "zh", "ko"] as const;
const wording = (locale: string): Tree => (JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sign: Tree }).Sign;
const at = (tree: Tree, path: string): string => path.split(".").reduce<unknown>((n, k) => (n as Tree)[k], tree) as string;

function page(locale: string, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ Sign: wording(locale) }}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const role = (key: string, label: string) => ({ key, label, kind: "signer" as const, color: 0 });
const uploaded: EnvelopeDocLite = { id: "up1", position: 1, title: "Scanned contract", roles: [], fromTemplate: false };
const templated: EnvelopeDocLite = { id: "t1", position: 2, title: "Merchant Agreement", roles: [role("merchant", "Merchant"), role("director", "Director")], fromTemplate: true };

const person = (over: Partial<EnvelopePerson> = {}): EnvelopePerson => ({ key: "pp_aaaaaaaa", fullName: "Ali Hassan", email: "ali@example.com", phone: "", channel: "email", step: 1, roles: {}, ...over });
const copy = (over: Partial<EnvelopePerson> = {}): EnvelopePerson => person({ key: "pp_cccccccc", fullName: "Cara Lim", email: "cara@example.com", type: "copy", ...over });

const noop = () => {};
function people(locale: string, over: Partial<React.ComponentProps<typeof EnvelopePeople>> = {}) {
  return page(locale, <EnvelopePeople kind="collection" docs={[uploaded]} people={[person(), copy()]} ordered={false} readOnly={false} showInvalid={false} whatsappConfigured onPeople={noop} onOrdered={noop} {...over} />);
}

const DISABLED = /\sdisabled(=|>|\s)/;
function openingTagOfButtonWith(html: string, text: string): string {
  const pos = html.indexOf(text);
  expect(pos, `"${text}" on the page`).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<button", pos);
  return html.slice(open, html.indexOf(">", open) + 1);
}

beforeEach(() => {
  hoisted.nameBoxes.length = 0;
  hoisted.can.value = true;
});

describe("the People step of a draft collection", () => {
  for (const locale of LOCALES) {
    const w = wording(locale);
    const words = (path: string) => at(w, `send.envelope.people.${path}`);

    it(`shows name, email and type for each person, and no role for each document (${locale})`, () => {
      const html = people(locale);
      expect(html).toContain('value="ali@example.com"');
      expect(html).toContain('value="cara@example.com"');
      // the name boxes are the contact search boxes
      expect(hoisted.nameBoxes.map((b) => b.value)).toEqual(["Ali Hassan", "Cara Lim"]);
      expect(html).toContain(words("type.signer"));
      expect(html).toContain(words("type.copy"));
      expect(html).toContain(words("add"));
      expect(html).toContain(words("addCopy"));
      // nothing per document: no "Role on ..." and no select named after a document
      expect(html).not.toContain("up1");
      expect(html).not.toContain("Scanned contract");
      expect(html).not.toMatch(/Role on|Not on this document/);
      // the type is two radio buttons (no select), each person's own pair holding their type
      expect(html).not.toContain("<select");
      expect(html).toMatch(/<input type="radio"[^>]*name="pp_aaaaaaaa-type"[^>]*checked=""[^>]*value="signer"/);
      expect(html).toMatch(/<input type="radio"[^>]*name="pp_cccccccc-type"[^>]*checked=""[^>]*value="copy"/);
    });

    it(`gives a person who must sign a step but no channel, and a person who receives a copy only a name, an email and a line (${locale})`, () => {
      const html = people(locale, { ordered: true });
      const [signerCard, copyCard] = html.split("<li ").slice(1);
      expect(signerCard).not.toContain("pp_aaaaaaaa-channel");
      expect(signerCard).toContain("pp_aaaaaaaa-step");
      expect(signerCard).not.toContain(words("copyLine"));
      expect(copyCard).not.toContain("pp_cccccccc-channel");
      expect(copyCard).not.toContain("pp_cccccccc-step");
      expect(copyCard).not.toContain("pp_cccccccc-phone");
      expect(copyCard).toContain(words("copyLine"));
    });

    it(`has the Match the template's roles section only when a document came from a template (${locale})`, () => {
      const heading = words("template.heading").replace(/'/g, "&#x27;"); // as the markup escapes it
      expect(people(locale, { docs: [uploaded] })).not.toContain(heading);
      const html = people(locale, { docs: [uploaded, templated] });
      expect(html).toContain(heading);
      // one dropdown for each role of the template's document, grouped under its title, with the people who sign and "Nobody"
      expect(html).toContain("Merchant Agreement");
      expect(html).toContain('id="match-t1-merchant"');
      expect(html).toContain('id="match-t1-director"');
      expect(html).toContain(words("template.nobody"));
      expect(html.match(/<option value="pp_aaaaaaaa"/g)).toHaveLength(2);
      expect(html).not.toContain('<option value="pp_cccccccc"');
    });
  }

  it("preselects the person who has a template role, and warns about a role nobody has or two have (template documents only)", () => {
    const html = people("en", { docs: [uploaded, templated], people: [person({ roles: { t1: "merchant" } }), person({ key: "pp_bbbbbbbb", fullName: "Bea", email: "bea@example.com", roles: { t1: "merchant" } })] });
    expect(html).toMatch(/<select id="match-t1-merchant"[^>]*>(?:(?!<\/select>)[\s\S])*<option value="pp_aaaaaaaa" selected/);
    expect(html).toContain("more than one person");
    // an uploaded-only collection has nothing to warn about even with nobody on it
    expect(people("en", { docs: [uploaded], people: [] })).not.toMatch(/Things to fix/);
    const nobody = people("en", { docs: [templated], people: [person()] });
    expect(nobody).toContain("Things to fix");
  });

  it("shows how a person who must sign is asked to be completed on a template-only collection", () => {
    const html = people("en", { docs: [templated], people: [person()], showInvalid: true });
    expect(html).toContain("Choose this person");
    // an uploaded file gives everybody a place, so nothing is wrong
    expect(people("en", { docs: [uploaded], people: [person()], showInvalid: true })).not.toContain("Choose this person");
  });

  it("stops adding at the limits: 6 who sign when a file was uploaded, 20 otherwise, and 10 who receive a copy", () => {
    const six = Array.from({ length: 6 }, (_, i) => person({ key: `pp_s${i}aaaaaa`, fullName: `S${i}`, email: `s${i}@example.com` }));
    const withUpload = people("en", { docs: [uploaded], people: six });
    expect(openingTagOfButtonWith(withUpload, "Add a person</button>".replace("</button>", ""))).toMatch(DISABLED);
    expect(withUpload).toContain("Up to 6 people can be asked to sign an uploaded file");
    const templateOnly = people("en", { docs: [templated], people: six });
    expect(openingTagOfButtonWith(templateOnly, "Add a person")).not.toMatch(DISABLED);
    const ten = Array.from({ length: 10 }, (_, i) => copy({ key: `pp_c${i}aaaaaa`, fullName: `C${i}`, email: `c${i}@example.com` }));
    const manyCopies = people("en", { docs: [uploaded], people: ten });
    expect(openingTagOfButtonWith(manyCopies, "Add a person who receives a copy")).toMatch(DISABLED);
    expect(manyCopies).toContain("Up to 10 people can receive a copy");
  });

  it("shows nothing to edit to someone who cannot send", () => {
    const html = people("en", { readOnly: true });
    expect(openingTagOfButtonWith(html, "Add a person")).toMatch(DISABLED);
    expect(html.match(/<input type="radio"[^>]*>/g)).toHaveLength(4);
    expect(html.match(/<input type="radio"[^>]*>/g)?.every((r) => DISABLED.test(r))).toBe(true);
  });

  it("switches a person to receive a copy: the channel and the step are gone from their card", () => {
    const start = [person({ channel: "whatsapp", phone: "+60123456789" })];
    // a person saved earlier with WhatsApp keeps their number and is told so; nothing offers a channel
    const before = people("en", { people: start, ordered: true });
    expect(before).toContain("pp_aaaaaaaa-phone");
    expect(before).toContain("Sent by WhatsApp");
    expect(before).not.toContain("pp_aaaaaaaa-channel");
    const next = setPersonType(start, "pp_aaaaaaaa", "copy", [uploaded]);
    const html = people("en", { people: next, ordered: true });
    expect(html).not.toContain("pp_aaaaaaaa-channel");
    expect(html).not.toContain("pp_aaaaaaaa-phone");
    expect(html).not.toContain("pp_aaaaaaaa-step");
    expect(html).not.toContain("Sent by WhatsApp");
    expect(html).toContain("They get the signed copy by email");
    expect(html).toMatch(/<input type="radio"[^>]*name="pp_aaaaaaaa-type"[^>]*checked=""[^>]*value="copy"/);
  });

  it("wires a chosen contact to the person: name and email filled, the email still editable, the contact never saved", () => {
    const onPeople = vi.fn();
    people("en", { people: [person({ fullName: "Dew", email: "" })], onPeople });
    const box = hoisted.nameBoxes[0];
    box.onPickContact({ id: "c-1", name: "Dewi Sartika", email: "dewi@example.com", phone: null, company: null });
    const picked = onPeople.mock.calls[0][0] as EnvelopePerson[];
    expect(picked[0]).toMatchObject({ key: "pp_aaaaaaaa", fullName: "Dewi Sartika", email: "dewi@example.com", contactId: "c-1" });
    // typing a name is just typing
    box.onChange("Dewi S");
    expect((onPeople.mock.calls[1][0] as EnvelopePerson[])[0].fullName).toBe("Dewi S");
  });

  it("takes a contact's name and email, keeps the typed email when the contact has none, and the phone only for someone who signs", () => {
    const docs = [uploaded];
    const none = applyContact([person({ email: "typed@example.com" })], "pp_aaaaaaaa", { id: "c2", name: "Eka", email: null, phone: "+60111" }, docs);
    expect(none[0]).toMatchObject({ fullName: "Eka", email: "typed@example.com", phone: "+60111", contactId: "c2" });
    const asCopy = applyContact([copy()], "pp_cccccccc", { id: "c3", name: "Fay", email: "fay@example.com", phone: "+60222" }, docs);
    expect(asCopy[0]).toMatchObject({ fullName: "Fay", email: "fay@example.com", phone: "" });
    // choosing a contact whose name is a template role's label matches the role
    const labelled: EnvelopeDocLite = { ...templated, roles: [role("merchant", "Dewi Sartika")] };
    const matched = applyContact([person({ fullName: "D", email: "" })], "pp_aaaaaaaa", { id: "c4", name: "Dewi Sartika", email: "d@example.com" }, [labelled]);
    expect(matched[0].roles).toEqual({ t1: "merchant" });
  });
});

describe("removing a person", () => {
  const work = [
    { id: "up1", fromTemplate: false, fieldCounts: { pp_aaaaaaaa: 3 } },
    { id: "up2", fromTemplate: false, fieldCounts: { pp_aaaaaaaa: 1 } },
  ];

  it("asks first when fields are assigned to a person who must sign, and not otherwise", () => {
    const list = [person(), person({ key: "pp_bbbbbbbb", fullName: "Bea", email: "bea@example.com" }), copy()];
    expect(removalAsk(list, "pp_aaaaaaaa", work, "Person 1")).toEqual({ key: "pp_aaaaaaaa", name: "Ali Hassan", fields: 4, documents: 2 });
    expect(removalAsk(list, "pp_bbbbbbbb", work, "Person 2")).toBeNull(); // nothing assigned
    expect(removalAsk(list, "pp_cccccccc", work, "Person 3")).toBeNull(); // a copy has no fields
    expect(removalAsk([person({ fullName: " " })], "pp_aaaaaaaa", work, "Person 1")?.name).toBe("Person 1");
  });

  for (const locale of LOCALES) {
    it(`words the question with the person, the fields and the documents (${locale})`, () => {
      const ask = { key: "k", name: "Ali Hassan", fields: 4, documents: 2 };
      const title = page(locale, <RemovalWords ask={ask} part="title" />);
      const body = page(locale, <RemovalWords ask={ask} part="body" />);
      expect(title).toContain("Ali Hassan");
      expect(body).toContain("4");
      expect(body).toContain("2");
      if (locale === "en") {
        expect(title).toBe("Remove Ali Hassan?");
        expect(body).toBe("The 4 fields assigned to them, on 2 documents, will be removed too.");
      }
    });
  }
});

// ---- a sent collection ----------------------------------------------------------------------------------------

const env = (status: SignEnvelopeRow["status"]): SignEnvelopeRow => ({
  id: "e1", account_id: "a1", reference: "ENV-2026-000001", title: "Onboarding", status, contact_id: null, message: null, locale: "en", sign_in_order: false, code_required: false,
  reminder_days: [], expires_at: null, sent_at: "2026-10-01T00:00:00Z", completed_at: null, void_reason: null, end_notified_at: null, created_by: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
});
const copyRow = (id: string, name: string, notified: string | null): SignCopyRecipientRow => ({ id, account_id: "a1", document_id: null, envelope_id: "e1", full_name: name, email: `${id}@example.com`, notified_at: notified, created_by: null, created_at: "2026-10-01T00:00:00Z" });
const documentSummary = (n: number, status: "sent" | "completed"): EnvelopeData["documents"][number] => ({
  id: `0000000${n}-0000-4000-8000-000000000000`, position: n, title: `Document ${n}`, reference: null, status, mode: "sign", pageCount: 1, roles: [], rolesNeeded: [], fromTemplate: false, fieldCounts: {}, signatureCounts: {}, partCounts: {}, hasFile: true, hasForm: false, categoryId: null, completedAt: null, hasFinalFile: false,
});
const signerRow = (n: number): EnvelopeData["signers"][number] =>
  ({ id: `s${n}`, account_id: "a1", document_id: documentSummary(n, "sent").id, role_key: "pp_aaaaaaaa", kind: "signer", full_name: "Ali Hassan", email: "ali@example.com", phone: null, channel: "email", order_no: 1, status: "sent", party_id: "s1", last_reminded_at: null }) as unknown as EnvelopeData["signers"][number];

const detail = (status: "sent" | "completed", copies: SignCopyRecipientRow[]): EnvelopeData => ({
  envelope: env(status),
  documents: [documentSummary(1, status), documentSummary(2, status)],
  signers: [signerRow(1), signerRow(2)],
  copies,
  problems: [],
  headroom: null,
  links: { ticketId: null, dealId: null },
});

describe("the people of a sent collection", () => {
  for (const locale of LOCALES) {
    const w = wording(locale);
    const d = (path: string) => at(w, `detail.collectionCopies.${path}`);

    it(`lists the people who receive a copy with their label and whether the copy went out, and lets the sender add and remove while it is open (${locale})`, () => {
      const html = page(locale, <EnvelopeDetail data={detail("sent", [copyRow("k1", "Cara Lim", null)])} reload={async () => null} />);
      expect(html).toContain("Cara Lim");
      expect(html).toContain("k1@example.com");
      expect(html).toContain(d("receivesCopy"));
      // not completed yet: they will get it when everything is signed (not "not sent")
      expect(html).toContain(d("afterSigned"));
      expect(html).not.toContain(d("notSent"));
      // open and the viewer may send: remove and add
      expect(html).toContain(d("addHeading"));
      expect(html).toContain(`aria-label="${d("remove").replace("{name}", "Cara Lim")}"`);
      expect(html).toContain('id="env-copy-email"');
    });

    it(`says when the copy was sent, or that it was not, once it is completed and closed to changes (${locale})`, () => {
      const html = page(locale, <EnvelopeDetail data={detail("completed", [copyRow("k1", "Cara Lim", "2026-10-05T08:00:00Z"), copyRow("k2", "Dev Raj", null)])} reload={async () => null} />);
      expect(html).toContain(d("receivesCopy"));
      expect(html).toContain(d("notSent"));
      expect(html).not.toContain(d("afterSigned"));
      expect(html).not.toContain(d("addHeading"));
      expect(html).not.toContain(d("removeShort"));
      if (locale === "en") expect(html).toContain("Copy sent Oct 5, 2026");
    });
  }

  it("does not count them as people who sign, nor offer them a reminder", () => {
    const html = page("en", <EnvelopeDetail data={detail("sent", [copyRow("k1", "Cara Lim", null), copyRow("k2", "Dev Raj", null)])} reload={async () => null} />);
    // one person signs (on two documents); the heading counts only them, the progress is of documents
    expect(html).toContain("1 person");
    expect(html).not.toContain("3 people");
    expect(html).toContain("0 of 2 documents are complete.");
    // one set of Remind / Resend / Change recipient, for the one signer
    expect(html.match(/>Remind</g)).toHaveLength(1);
  });

  it("offers no adding or removing to someone who cannot send", () => {
    hoisted.can.value = false;
    const html = page("en", <EnvelopeDetail data={detail("sent", [copyRow("k1", "Cara Lim", null)])} reload={async () => null} />);
    expect(html).toContain("Cara Lim");
    expect(html).not.toContain("Add a person who receives a copy");
    expect(html).not.toContain("Remove Cara Lim");
  });
});

describe("the words of a draft collection's new problems", () => {
  for (const locale of LOCALES) {
    it(`has a sentence for each new code and for every copy error (${locale})`, () => {
      const w = wording(locale);
      for (const code of ["person_without_work", "document_nobody", "too_many_copies", "too_many_roles"]) expect(at(w, `send.envelope.problems.${code}`).length).toBeGreaterThan(10);
      for (const code of ["copy_name", "copy_email", "copy_duplicate", "copy_is_signer", "copy_limit", "copy_not_open", "copy_fixed", "copy_recipient_not_found"]) expect(at(w, `send.errors.${code}`).length).toBeGreaterThan(5);
    });
  }

  it("tells the sender in plain words what to do when nobody has anything to do on a document", () => {
    expect(at(wording("en"), "send.envelope.problems.document_nobody")).toBe("Nobody has anything to do on this document yet. Open it and assign a signature block to a person.");
    expect(at(wording("en"), "send.envelope.problems.person_without_work")).toContain("Open a document and assign a field to them, or change them to receive a copy.");
  });

  it("starts a person from the people helper with the type the button says", () => {
    expect(addPerson([], [uploaded], "copy")[0].type).toBe("copy");
    expect(addPerson([], [uploaded], "signer")[0].type).toBeUndefined();
  });
});

// ---- Download all (zip) and the certificates of a completed collection (migration 178) ----------------------------------------

describe("the downloads of a collection", () => {
  const withFiles = (status: "sent" | "completed", flags: { final: boolean; certificate: boolean }): EnvelopeData => {
    const d = detail(status, []);
    return { ...d, documents: d.documents.map((x) => ({ ...x, hasFinalFile: flags.final, hasCertificate: flags.certificate })) };
  };
  const ZIP = '/api/sign/envelopes/e1/zip"';

  for (const locale of LOCALES) {
    it(`offers ONE 'Download all (zip)' and a certificate beside each signed document that has one (${locale})`, () => {
      const w = wording(locale);
      const all = at(w, "send.envelope.detail.downloadAll");
      const certificate = at(w, "send.envelope.detail.certificate");
      const html = page(locale, <EnvelopeDetail data={withFiles("completed", { final: true, certificate: true })} reload={async () => null} />);
      expect(html.split(ZIP)).toHaveLength(2);
      expect(html).toContain(all);
      expect(html.split(`>${certificate}<`).length - 1).toBe(2);
      for (const n of [1, 2]) {
        const id = `0000000${n}-0000-4000-8000-000000000000`;
        expect(html).toContain(`/api/sign/documents/${id}/file?kind=final&amp;download=1`);
        expect(html).toContain(`/api/sign/documents/${id}/file?kind=certificate&amp;download=1`);
      }
      if (locale === "en") {
        expect(all).toBe("Download all (zip)");
        expect(certificate).toBe("Certificate");
      } else {
        expect(all).not.toBe("Download all (zip)");
      }
    });
  }

  it("keeps the signed copy of each document, and the one zip, for a collection sealed before certificates were files of their own: no certificate link", () => {
    const html = page("en", <EnvelopeDetail data={withFiles("completed", { final: true, certificate: false })} reload={async () => null} />);
    expect(html).toContain(ZIP);
    expect(html).not.toContain("kind=certificate");
    expect(html).not.toContain(">Certificate<");
  });

  it("offers nothing to download while no document has a signed file", () => {
    const html = page("en", <EnvelopeDetail data={withFiles("sent", { final: false, certificate: false })} reload={async () => null} />);
    expect(html).not.toContain("/zip");
    expect(html).not.toContain("Download all (zip)");
  });
});
