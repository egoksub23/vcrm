import { getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";

import { certificateLabels, eventSentence } from "../certificate-words";
import { buildCertificate } from "../pdf/certificate";
import type { PlacedField } from "../pdf/types";
import { SIGN_LOCALES, type SignDocumentRow, type SignSignerRow } from "../types";
import { recordData } from "./record";
import { certificateData, valuesFor } from "./seal";

// What the sealed file and the certificate say about a role with two people (migration 187): the signature on the places and the name and time are those
// of the person who completed it; the certificate lists the other person as an alternate who did not need to sign, and the history says so, in every
// language, with who completed it.

const row = (id: string, over: Partial<SignSignerRow> = {}): SignSignerRow =>
  ({
    id,
    account_id: "a",
    document_id: "d",
    role_key: "merchant",
    kind: "signer",
    full_name: id,
    email: `${id}@kedai.example`,
    phone: null,
    channel: "email",
    order_no: 1,
    status: "viewed",
    internal_user_id: null,
    invited_at: "2026-10-06T07:00:00Z",
    viewed_at: null,
    signed_at: null,
    declined_at: null,
    decline_reason: null,
    ip: null,
    device: null,
    locale: null,
    consent_version: null,
    consented_at: null,
    last_reminded_at: null,
    reminder_count: 0,
    part_keys: null,
    delegated_by: null,
    forward_count: 0,
    forward_history: [],
    alternate_of: null,
    created_at: "2026-10-06T06:00:00Z",
    updated_at: "2026-10-06T06:00:00Z",
    ...over,
  }) as SignSignerRow;

const fields: PlacedField[] = [
  { key: "msig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.08, required: true },
  { key: "mname", type: "name", role: "merchant", page: 0, x: 0.1, y: 0.3, w: 0.4, h: 0.04, required: false },
  { key: "mdate", type: "date_signed", role: "merchant", page: 0, x: 0.6, y: 0.4, w: 0.3, h: 0.04, required: false },
];
const roles = [{ key: "merchant", label: "Merchant", kind: "signer" as const, color: 0 }];
const doc = (over: Partial<SignDocumentRow> = {}) =>
  ({ id: "d", title: "Lease", reference: "SGN-2026-000001", locale: "en", mode: "sign", sign_in_order: false, roles_snapshot: roles, fields_snapshot: fields, form_snapshot: null, base_sha256: "a".repeat(64), sent_at: "2026-10-06T06:00:00Z", ...over }) as unknown as SignDocumentRow;
const info = { workspaceName: "Vircle", senderName: "Gokula", timeZone: "UTC" };

// Ali was named first, Siti is the alternate; Siti completed it
const ali = row("Ali", { status: "not_needed" });
const siti = row("Siti Finance", { status: "signed", signed_at: "2026-10-06T09:00:00Z", alternate_of: "Ali", email: "siti@kedai.example", created_at: "2026-10-06T06:01:00Z", ip: "203.0.113.7" });

describe("the places of a role with two people", () => {
  it("are the places of the person who completed it, whichever of them was named first", () => {
    const answers = [
      { signer_id: "Ali", field_key: "msig", value: { typed: "Ali (typed, not finished)" } },
      { signer_id: "Siti Finance", field_key: "msig", value: { typed: "Siti Finance" } },
    ];
    for (const people of [[ali, siti], [siti, ali]]) {
      const values = valuesFor(fields, people, answers);
      expect(values.msig).toEqual({ typed: "Siti Finance" });
      expect(values.mname).toEqual({ text: "Siti Finance" });
      expect(values.mdate).toEqual({ at: new Date("2026-10-06T09:00:00Z") });
    }
  });

  it("are still the first person's when they completed it", () => {
    const first = row("Ali", { status: "signed", signed_at: "2026-10-06T08:00:00Z" });
    const second = row("Siti Finance", { status: "not_needed", alternate_of: "Ali" });
    expect(valuesFor(fields, [first, second], [{ signer_id: "Ali", field_key: "msig", value: { typed: "Ali" } }]).mname).toEqual({ text: "Ali" });
  });
});

describe("the certificate of a role with two people", () => {
  it("lists the person who did not need to sign as such, beside the person who signed, with no signing time", () => {
    const data = certificateData(doc(), [ali, siti], [], info, "https://halo.test", 1);
    expect(data.signers.map((s) => [s.name, s.status, s.signedAt ? "time" : "-"])).toEqual([["Ali", "not_needed", "-"], ["Siti Finance", "signed", "time"]]);
    expect(data.signers[1].ip).toBe("203.0.113.7");
    expect(data.labels?.statusNotNeeded).toBe("Alternate: did not need to sign");
  });

  it("says in the history who was invited as an alternate and who completed the role", () => {
    const events = [{ created_at: "2026-10-06T09:00:01Z", type: "alternate_not_needed", signer_id: "Ali", row_hash: "h1", detail: { role: "merchant", completed_by: "Siti Finance", completed_by_name: "Siti Finance" } }];
    const data = certificateData(doc(), [ali, siti], events, info, "https://halo.test", 1);
    expect(data.events.map((e) => e.text)).toEqual(["Ali was invited as an alternate and did not need to sign: Siti Finance completed the role first"]);
    // the other languages and a form
    for (const locale of SIGN_LOCALES) {
      const text = eventSentence("alternate_not_needed", locale, { actor: "Ali", sender: "Gokula" }, { detail: events[0].detail });
      expect(text, locale).toContain("Ali");
      expect(text, locale).toContain("Siti Finance");
      const form = eventSentence("alternate_not_needed", locale, { actor: "Ali", sender: "Gokula" }, { detail: events[0].detail, mode: "form" });
      expect(form, `${locale} form`).toContain("Siti Finance");
      expect(form, `${locale} form`).not.toBe(text);
    }
  });

  it("has a status word in every language, for a document and for a form, that is not the word for 'not signed'", () => {
    for (const locale of SIGN_LOCALES) {
      for (const mode of ["sign", "form"] as const) {
        const labels = certificateLabels(locale, mode);
        expect(labels.statusNotNeeded, `${locale} ${mode}`).toBeTruthy();
        expect(labels.statusNotNeeded).not.toBe(labels.statusPending);
      }
    }
  });
});

describe("the certificate pages", () => {
  async function pageText(bytes: Uint8Array): Promise<string> {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const out: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      out.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
    }
    return out.join(" ").replace(/\s+/g, "");
  }

  it.each(SIGN_LOCALES)("print the alternate's status and who signed, in %s", async (locale) => {
    const data = certificateData(doc({ locale }), [ali, siti], [], info, "https://halo.test", 1);
    const { bytes } = await buildCertificate({ ...data, labels: certificateLabels(locale) });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const text = await pageText(bytes);
    // (the text of a Chinese or Korean page cannot be read back out of the file; that it was drawn without a missing glyph is the check there)
    if (locale === "zh" || locale === "ko") return;
    expect(text).toContain(certificateLabels(locale).statusNotNeeded.replace(/\s+/g, ""));
    expect(text).toContain("SitiFinance");
    expect(text).toContain("Ali");
  });
});

describe("the submission record of a form with two people on a role", () => {
  it("names the people who submitted, never the one who was not needed", () => {
    const formDoc = doc({
      mode: "form",
      fields_snapshot: [],
      form_snapshot: { version: 1, parts: [{ key: "company", title: { en: "Company" }, role: "merchant" }], fields: [{ key: "legalName", type: "text", part: "company", label: { en: "Legal name" }, required: true }] } as never,
    });
    const filler = (r: SignSignerRow) => ({ ...r, kind: "filler" as const });
    const data = recordData(formDoc, [filler(ali), filler(siti)], [{ signer_id: "Ali", field_key: "legalName", value: { text: "Kedai Ali" } }], [], { workspaceName: "Vircle", timeZone: "UTC" });
    expect(data.people).toEqual([{ name: "Siti Finance", role: "Merchant" }]);
    expect(data.parts[0].rows[0].text).toContain("Kedai Ali");
  });
});
