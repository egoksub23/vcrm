import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// What the sender sees of a role with two people (migration 187), with the real wording in every language (next-intl throws on a missing key or
// argument): the two people with who can sign instead of whom, the person who did not need to sign with a word for it and no buttons, the progress
// that counts the role once, and the history line that says who completed it.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("@/hooks/use-account-members", () => ({ useAccountMembers: () => ({ members: [], nameOf: () => "", profileOf: () => undefined }) }));

import type { SignDocumentRow, SignSignerRow } from "@/lib/sign/types";
import { describeEvent } from "./events";
import { bannerFor, signerActions } from "./logic";
import { PeopleList } from "./people-list";

type Tree = Record<string, unknown>;
const LOCALES = ["en", "ms", "zh", "ko"] as const;
const messages = (locale: string): Tree => {
  const sign = (JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sign: { detail: Tree; send: { status: Tree } } }).Sign;
  return { Sign: { detail: sign.detail, send: { status: sign.send.status } } };
};

function page(locale: string, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={messages(locale)}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const doc = (over: Partial<SignDocumentRow> = {}): SignDocumentRow =>
  ({
    id: "d1",
    account_id: "a1",
    reference: "SGN-2026-000123",
    title: "Lease",
    status: "in_progress",
    roles_snapshot: [
      { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
      { key: "director", label: "Director", kind: "signer", color: 1 },
    ],
    form_snapshot: null,
    fields_snapshot: [],
    sign_in_order: false,
    mode: "sign",
    ...over,
  }) as unknown as SignDocumentRow;

const signer = (over: Partial<SignSignerRow>): SignSignerRow =>
  ({
    id: "s1",
    account_id: "a1",
    document_id: "d1",
    role_key: "merchant",
    kind: "signer",
    full_name: "Ali bin Ahmad",
    email: "ali@kedai.example",
    phone: null,
    channel: "email",
    order_no: 1,
    status: "sent",
    internal_user_id: null,
    invited_at: "2026-10-06T09:10:00Z",
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
    created_at: "2026-10-06T09:04:00Z",
    updated_at: "2026-10-06T09:04:00Z",
    ...over,
  }) as SignSignerRow;

const caps = { send: true, void: true, reveal: true, settings: true };
const ali = (over: Partial<SignSignerRow> = {}) => signer({ id: "s1", ...over });
const siti = (over: Partial<SignSignerRow> = {}) => signer({ id: "s2", full_name: "Siti Finance", email: "siti@kedai.example", alternate_of: "s1", created_at: "2026-10-06T09:05:00Z", ...over });
const lim = (over: Partial<SignSignerRow> = {}) => signer({ id: "s3", full_name: "Lim Director", email: "lim@kedai.example", role_key: "director", order_no: 2, ...over });

describe("the people of a role with two people", () => {
  for (const locale of LOCALES) {
    it(`says who can sign instead of whom while both are open, and who did not need to sign afterwards (${locale})`, () => {
      const open = page(locale, <PeopleList document={doc()} signers={[ali(), siti(), lim()]} undelivered={new Set()} caps={caps} onChanged={async () => {}} />);
      expect(open.match(/data-alternate/g)).toHaveLength(2);
      expect(open).toContain("Siti Finance");

      const done = page(locale, <PeopleList document={doc()} signers={[ali({ status: "not_needed" }), siti({ status: "signed", signed_at: "2026-10-06T10:00:00Z" }), lim()]} undelivered={new Set()} caps={caps} onChanged={async () => {}} />);
      expect(done).toContain("Ali bin Ahmad");
      // the person who did not need to sign names who completed it
      expect(done.match(/Siti Finance/g)!.length).toBeGreaterThanOrEqual(3);
    });
  }

  it("offers nothing to do to a person who is not needed: no reminder, no new link, no change of recipient", () => {
    expect(signerActions("in_progress", { status: "not_needed", last_reminded_at: null }, caps, new Date(), false)).toMatchObject({ open: false, remind: false, resend: false, changeRecipient: false, move: false });
    const done = page("en", <PeopleList document={doc()} signers={[ali({ status: "not_needed" }), siti({ status: "signed", signed_at: "2026-10-06T10:00:00Z" })]} undelivered={new Set()} caps={caps} onChanged={async () => {}} />);
    expect(done).toContain("Not needed");
    expect(done).toContain("Did not need to sign: Siti Finance completed it first.");
    expect(done).not.toMatch(/>\s*Remind\s*</);
  });

  it("counts the people of a step as places when the document needs order", () => {
    const html = page("en", <PeopleList document={doc({ sign_in_order: true })} signers={[ali(), siti(), lim()]} undelivered={new Set()} caps={caps} onChanged={async () => {}} />);
    expect(html).toContain("Step 1 (1 person)");
    expect(html).toContain("Step 2 (1 person)");
  });
});

describe("the banner and the history of a role with two people", () => {
  it("counts the role once, done when either person has signed, and waits for neither once it is done", () => {
    const waiting = bannerFor({ status: "in_progress", completed_at: null, expires_at: null, void_reason: null, seal_error: null }, [ali(), siti(), lim()], { settings: true });
    expect(waiting).toMatchObject({ kind: "waiting", done: 0, total: 2 });
    const after = bannerFor({ status: "in_progress", completed_at: null, expires_at: null, void_reason: null, seal_error: null }, [ali({ status: "not_needed" }), siti({ status: "signed" }), lim()], { settings: true });
    expect(after).toMatchObject({ kind: "waiting", done: 1, total: 2, names: ["Lim Director"], more: 0 });
  });

  it("words the event with the person who did not need to sign and the one who completed it, for a form too", () => {
    const ctx = { signers: [{ id: "s1", full_name: "Ali bin Ahmad", order_no: 1 }], signInOrder: false, userName: () => null, someone: "Someone", teammate: "A teammate" };
    const event = { id: "e1", doc_seq: 5, signer_id: "s1", type: "alternate_not_needed", actor_type: "system" as const, actor_user_id: null, detail: { role: "merchant", completed_by: "s2", completed_by_name: "Siti Finance" }, ip: null, device: null, created_at: "2026-10-06T10:00:01Z" };
    expect(describeEvent(event, ctx)).toMatchObject({ key: "events.alternate_not_needed", values: { actor: "Ali bin Ahmad", by: "Siti Finance" } });
    expect(describeEvent(event, { ...ctx, mode: "form" }).key).toBe("events.alternate_not_neededForm");
    expect(describeEvent({ ...event, detail: {} }, ctx).values.by).toBe("Someone");
  });
});
