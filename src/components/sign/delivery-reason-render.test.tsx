import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// Why a message did not arrive, said in the reader's language: under each invitation after Send, and on the people list (with the wording that does
// not blame the address when the cause is the mailbox). With the screens' real messages, in every language, and none of it a raw key.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "u-me" } }) }));
vi.mock("sonner", () => ({ toast: { success: () => undefined, error: () => undefined, warning: () => undefined } }));

import { SEND_REASONS, reasonDetail } from "@/lib/email/send-reason";
import type { SignDocumentRow, SignSignerRow } from "@/lib/sign/types";
import { DeliveryReason } from "./delivery-reason";
import { PeopleList } from "./detail/people-list";
import { SendResult } from "./send/send-result";

const LOCALES = ["en", "ms", "zh", "ko"] as const;
type Tree = Record<string, unknown>;
const signMessages = (locale: string) => (JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sign: Tree }).Sign;

const wrap = (locale: string, node: React.ReactNode) => (
  <NextIntlClientProvider locale={locale} timeZone="UTC" messages={{ Sign: signMessages(locale) }} onError={(e) => { throw e; }}>
    {node}
  </NextIntlClientProvider>
);
const html = (locale: string, node: React.ReactNode) => renderToStaticMarkup(wrap(locale, node));
const reasonText = (locale: string, key: string) => ((signMessages(locale).delivery as Tree).reasons as Record<string, string>)[key];
const clean = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe.each(LOCALES)("the reason line (%s)", (locale) => {
  it.each([...SEND_REASONS])("says %s in words", (reason) => {
    const out = clean(html(locale, <DeliveryReason detail={reasonDetail(reason, "the service said x")} />));
    expect(out).toContain(reasonText(locale, reason));
    // a named reason shows the sentence, not the service's own words
    expect(out).not.toContain("the service said x");
    expect(out).not.toMatch(/Sign\.delivery|reasons\./);
  });

  it("shows what the service said when the failure is not one we name, and nothing when there is nothing to say", () => {
    expect(clean(html(locale, <DeliveryReason detail="MailboxNotEnabledForRESTAPI" />))).toContain("MailboxNotEnabledForRESTAPI");
    expect(html(locale, <DeliveryReason detail={null} />)).toBe("");
    expect(html(locale, <DeliveryReason detail="  " />)).toBe("");
  });
});

describe("every language has every reason and no placeholder the others lack", () => {
  it("has the same keys and placeholders", () => {
    const en = (signMessages("en").delivery as Tree).reasons as Record<string, string>;
    for (const locale of LOCALES) {
      const other = (signMessages(locale).delivery as Tree).reasons as Record<string, string>;
      expect(Object.keys(other).sort()).toEqual(Object.keys(en).sort());
      for (const key of SEND_REASONS) expect(other[key], `${locale}.${key}`).toEqual(expect.any(String));
      for (const k of Object.keys(en)) expect([...other[k].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()).toEqual([...en[k].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort());
    }
  });

  it("never says the word envelope, or an environment variable, to the sender", () => {
    for (const locale of LOCALES) {
      const text = JSON.stringify((signMessages(locale).delivery as Tree) ?? {}) + JSON.stringify(((signMessages(locale).admin as Tree).email as Tree) ?? {});
      expect(text).not.toMatch(/envelope|RESEND|API_KEY/i);
    }
  });
});

describe.each(LOCALES)("after Send (%s)", (locale) => {
  const result = {
    documentId: "d1",
    reference: "SGN-1",
    expiresAt: "2026-10-20T00:00:00Z",
    invited: [
      { signerId: "s1", name: "Ali", roleKey: "merchant", delivery: { channel: "email" as const, status: "failed" as const, detail: "daily_limit: Daily user sending quota exceeded." }, link: "https://halo.test/s/abc" },
      { signerId: "s2", name: "Siti", roleKey: "director", delivery: { channel: "email" as const, status: "not_configured" as const, detail: "not_set_up: no connected mailbox and the platform sender is not set up" }, link: "https://halo.test/s/def" },
      { signerId: "s3", name: "Budi", roleKey: "witness", delivery: { channel: "email" as const, status: "sent" as const } },
    ],
  };

  it("gives the reason under each invitation that did not arrive, and none under the one that did", () => {
    const out = clean(html(locale, <SendResult result={result} roles={[]} ordered={false} onOpenDocument={() => undefined} />));
    expect(out).toContain(reasonText(locale, "daily_limit"));
    expect(out).toContain(reasonText(locale, "not_set_up"));
    expect(out.split("data-delivery-reason").length - 1).toBe(2);
    // and the wording for "email is not set up" no longer points at anything but the mailbox or the platform sender
    const notConfigured = ((signMessages(locale).send as Tree).result as Tree).notConfigured as Record<string, string>;
    expect(out).toContain(notConfigured.email);
    expect(notConfigured.email).not.toMatch(/RESEND/i);
  });
});

describe.each(LOCALES)("on the people list (%s)", (locale) => {
  const doc = { id: "d1", account_id: "a1", reference: "SGN-1", title: "Agreement", status: "in_progress", sign_in_order: false, code_required: false, locale: "en", roles_snapshot: [{ key: "director", label: "Director", kind: "signer", color: 1 }], allow_forwarding: false, form_snapshot: null, expires_at: "2026-10-20T00:00:00Z" } as unknown as SignDocumentRow;
  const signer = { id: "s1", account_id: "a1", document_id: "d1", role_key: "director", kind: "signer", full_name: "Gokula", email: "g@vircle.example", phone: null, channel: "email", order_no: 1, status: "sent", internal_user_id: null, invited_at: "2026-10-06T09:10:00Z", viewed_at: null, signed_at: null, declined_at: null, decline_reason: null, last_reminded_at: null, reminder_count: 0, part_keys: null, delegated_by: null, forward_count: 0, forward_history: [], created_at: "2026-10-06T09:04:00Z", updated_at: "2026-10-06T09:10:00Z" } as unknown as SignSignerRow;
  const list = (reason: string | null | undefined) => (
    <PeopleList document={doc} signers={[signer]} undelivered={new Set(["s1"])} reasons={reason === undefined ? undefined : new Map([["s1", reason]])} caps={{ send: true, void: true, reveal: true, settings: true }} onChanged={async () => {}} />
  );
  const detail = (path: string) => path.split(".").reduce<unknown>((n, k) => (n as Tree)[k], signMessages(locale).detail) as string;

  it("shows the reason, and does not tell the sender to check the address when the cause is the mailbox", () => {
    const out = clean(html(locale, list("mailbox_reconnect: The refresh token has expired.")));
    expect(out).toContain(reasonText(locale, "mailbox_reconnect"));
    expect(out).toContain(detail("people.undeliveredEmailSetup"));
    expect(out).not.toContain(detail("people.undeliveredEmail"));
  });

  it("keeps the old wording when the address was refused, or when no reason was recorded", () => {
    const refused = clean(html(locale, list("address_rejected: Invalid To header")));
    expect(refused).toContain(detail("people.undeliveredEmail"));
    expect(refused).toContain(reasonText(locale, "address_rejected"));
    const unknown = clean(html(locale, list(null)));
    expect(unknown).toContain(detail("people.undeliveredEmail"));
    expect(unknown).not.toContain("data-delivery-reason");
    // older screens that pass no reasons at all still work
    expect(clean(html(locale, list(undefined)))).toContain(detail("people.undeliveredEmail"));
  });
});
