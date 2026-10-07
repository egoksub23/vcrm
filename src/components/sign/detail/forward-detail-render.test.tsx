import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// Render smoke tests for what the sender sees of steps and forwarding (F-68, F-69, F-70, F-95), in every language,
// with the real wording; next-intl is told to throw on a missing key or argument. They run once the Doc Sign message
// fragments of this package are merged into messages/*.json.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-account-members", () => ({
  useAccountMembers: () => ({ members: [], nameOf: (id: string | null | undefined) => (id === "u1" ? "Gokula" : ""), profileOf: () => undefined }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));

import { roleViews } from "@/lib/sign/client/progress-logic";
import type { StaffProgress } from "@/lib/sign/forms/api-types";
import type { FormDefinition } from "@/lib/sign/forms/types";
import type { SignDocumentRow, SignSignerRow } from "@/lib/sign/types";
import { describeEvent } from "./events";
import { DetailHeader } from "./detail-header";
import { HistoryView } from "./history-view";
import { documentActions, signerActions } from "./logic";
import { PeopleList } from "./people-list";
import { RoleProgressCard } from "./progress/role-progress-card";

type Tree = Record<string, unknown>;
function wording(locale: string): { detail: Tree; progress: Tree } | null {
  const file = join(process.cwd(), "messages", `${locale}.json`);
  if (!existsSync(file)) return null;
  const sign = (JSON.parse(readFileSync(file, "utf8")) as { Sign?: { detail?: Tree & { people?: Tree }; progress?: Tree } }).Sign;
  if (!sign?.detail || !sign.progress || !sign.detail.forwarding) return null;
  return { detail: sign.detail, progress: sign.progress };
}
const LOCALES = ["en", "ms", "zh", "ko"].filter((l) => wording(l) !== null);

const STATUS = {
  document: { draft: "Draft", sent: "Sent", in_progress: "In progress", sealing: "Sealing", completed: "Completed", declined: "Declined", expired: "Expired", voided: "Cancelled", failed: "Failed" },
  signer: { pending: "Pending", sent: "Invited", viewed: "Opened", signed: "Signed", declined: "Declined", filled: "Filled in" },
  unknown: "Unknown",
};

function page(locale: string, node: React.ReactNode) {
  const w = wording(locale)!;
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ Sign: { detail: w.detail, progress: w.progress, send: { status: STATUS } } }}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const FORM: FormDefinition = {
  version: 1,
  parts: [
    { key: "company", title: { en: "Company details", ms: "Butiran syarikat" }, role: "merchant" },
    { key: "bank", title: { en: "Bank account", ms: "Akaun bank" }, role: "merchant" },
  ],
  fields: [],
};

const doc = (over: Partial<SignDocumentRow> = {}): SignDocumentRow =>
  ({
    id: "d1",
    account_id: "a1",
    reference: "SGN-2026-000123",
    title: "Merchant Agreement",
    status: "in_progress",
    category_id: null,
    template_version_id: null,
    contact_id: null,
    ticket_id: null,
    deal_id: null,
    merge_values: {},
    fields_snapshot: [],
    roles_snapshot: [
      { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
      { key: "director", label: "Director", kind: "signer", color: 1 },
      { key: "witness", label: "Witness", kind: "signer", color: 2 },
    ],
    form_snapshot: FORM,
    sign_in_order: true,
    code_required: false,
    allow_forwarding: true,
    locale: "en",
    message: null,
    expires_at: "2026-10-20T00:00:00Z",
    sent_at: "2026-10-06T09:10:00Z",
    completed_at: null,
    retain_until: null,
    original_path: null,
    original_type: null,
    original_sha256: null,
    base_path: "y",
    base_sha256: null,
    page_count: 3,
    final_path: null,
    final_sha256: null,
    void_reason: null,
    reminder_days: null,
    sealing_started_at: null,
    sealing_attempts: 0,
    seal_error: null,
    created_by: "u1",
    created_at: "2026-10-06T09:04:00Z",
    updated_at: "2026-10-06T09:10:00Z",
    ...over,
  }) as SignDocumentRow;

const signer = (over: Partial<SignSignerRow>): SignSignerRow =>
  ({
    id: "s1",
    account_id: "a1",
    document_id: "d1",
    role_key: "merchant",
    kind: "signer",
    full_name: "Ali bin Ahmad",
    email: "ali@kedairuncit.example",
    phone: null,
    channel: "email",
    order_no: 1,
    status: "signed",
    internal_user_id: null,
    invited_at: "2026-10-06T09:10:00Z",
    viewed_at: "2026-10-06T10:36:00Z",
    signed_at: "2026-10-06T10:42:00Z",
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
    created_at: "2026-10-06T09:04:00Z",
    updated_at: "2026-10-06T10:42:00Z",
    ...over,
  }) as SignSignerRow;

const caps = { send: true, void: true, reveal: true, settings: true };

describe("signerActions with steps", () => {
  it("lets a person who is not invited yet be re-addressed and, when the document needs order, moved; nobody else moves", () => {
    const pending = { status: "pending" as const, last_reminded_at: null };
    expect(signerActions("in_progress", pending, caps, new Date(), true)).toMatchObject({ changeRecipient: true, move: true, notInvited: true, remind: false, resend: false });
    expect(signerActions("in_progress", pending, caps, new Date(), false)).toMatchObject({ changeRecipient: true, move: false });
    expect(signerActions("in_progress", pending, { send: false }, new Date(), true)).toMatchObject({ changeRecipient: false, move: false });
    expect(signerActions("in_progress", { status: "sent" as const, last_reminded_at: null }, caps, new Date(), true)).toMatchObject({ move: false, changeRecipient: true });
    expect(signerActions("completed", pending, caps, new Date(), true)).toMatchObject({ move: false, changeRecipient: false });
  });
});

describe("the history words forwarding and steps", () => {
  const ctx = { signers: [{ id: "s1", full_name: "Siti", order_no: 2 }], signInOrder: true, userName: () => "Gokula", someone: "Someone", teammate: "A teammate", partTitle: (k: string) => (k === "bank" ? "Bank account" : null) };
  const row = (type: string, detail: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ id: type, doc_seq: 1, signer_id: "s1", type, actor_type: "signer" as const, actor_user_id: null, detail, ip: null, device: null, created_at: "2026-10-06T10:00:00Z", ...over });

  it("uses the event's own cause for an invitation, the forwarder's name on what they did, and names the part", () => {
    expect(describeEvent(row("invited", { because: "step_finished", step: 2 }, { actor_type: "system" }), ctx).key).toBe("events.invitedAfterStep");
    expect(describeEvent(row("invited", { because: "signer_finished", finished_name: "Ali", step: 2 }, { actor_type: "system" }), ctx)).toMatchObject({ key: "events.invitedAfter", values: { previous: "Ali" } });
    const forwarded = describeEvent(row("forwarded", { from_name: "Ali", to_name: "Siti" }), { ...ctx, nameAt: () => "Ali" });
    expect(forwarded).toMatchObject({ key: "events.forwarded", values: { from: "Ali", to: "Siti", actor: "Ali" }, actorName: "Ali" });
    expect(describeEvent(row("part_forwarded", { part: "bank", from_name: "Ali", to_name: "Siti" }), ctx).values).toMatchObject({ part: "Bank account", to: "Siti" });
    expect(describeEvent(row("forwarding_changed", { allow: false }, { actor_type: "user", signer_id: null }), ctx).key).toBe("events.forwarding_off");
    expect(describeEvent(row("forwarding_changed", { allow: true }, { actor_type: "user", signer_id: null }), ctx).key).toBe("events.forwarding_on");
    expect(describeEvent(row("signer_moved", { to_step: 3 }, { actor_type: "user" }), ctx).values.step).toBe("3");
  });
});

describe.skipIf(LOCALES.length === 0)("the detail screen shows steps and forwarding in every language", () => {
  for (const locale of LOCALES) {
    it(`people in steps, a delegate under the person who gave the part, a forwarded person, a person to move (${locale})`, () => {
      const people = [
        signer({ id: "s1", full_name: "Ali bin Ahmad", order_no: 1, status: "signed" }),
        signer({ id: "s2", full_name: "Siti Director", role_key: "director", order_no: 2, status: "sent", signed_at: null, viewed_at: null, forward_count: 1, forward_history: [{ name: "Wong Previous", at: "2026-10-06T11:00:00Z" }] }),
        signer({ id: "s2b", full_name: "Lim Witness", role_key: "witness", order_no: 2, status: "viewed", signed_at: null, created_at: "2026-10-06T09:05:00Z" }),
        signer({ id: "dg", full_name: "Finance Fiona", kind: "filler", role_key: "director", order_no: 2, status: "sent", signed_at: null, viewed_at: null, part_keys: ["bank"], delegated_by: "s2", created_at: "2026-10-06T12:00:00Z" }),
        signer({ id: "s3", full_name: "Later Person", role_key: "witness", order_no: 3, status: "pending", invited_at: null, viewed_at: null, signed_at: null }),
      ];
      const html = page(locale, <PeopleList document={doc()} signers={people} undelivered={new Set()} caps={caps} onChanged={async () => {}} form={FORM} />);
      for (const name of ["Ali bin Ahmad", "Siti Director", "Lim Witness", "Finance Fiona", "Later Person", "Wong Previous"]) expect(html).toContain(name);
      // one heading for each step, with how many people are in it
      expect(html.match(/data-step="/g)).toHaveLength(3);
      expect(html).toContain('data-step="2"');
      // the delegate's part is named; the person who is not invited yet can be moved
      expect(html).toMatch(/Bank account|Akaun bank/);
      expect(html).toContain("<select");
      // an unordered document shows no step headings
      expect(page(locale, <PeopleList document={doc({ sign_in_order: false })} signers={people} undelivered={new Set()} caps={caps} onChanged={async () => {}} form={FORM} />)).not.toContain("data-step=");
    });

    it(`the header's forwarding switch, and a part held by someone on the progress card (${locale})`, () => {
      const d = doc();
      const header = (allowed: boolean) =>
        page(
          locale,
          <DetailHeader document={d} links={{ category: null, contact: null, ticket: null, deal: null }} actions={documentActions(d, caps)} downloading={null} onView={() => {}} onDownload={() => {}} onVoid={() => {}} forwarding={{ allowed, busy: false, onChange: () => {} }} />,
        );
      expect(header(true)).toContain('role="checkbox"');
      expect(header(true)).toContain('aria-checked="true"');
      expect(header(false)).toContain('aria-checked="false"');
      expect(page(locale, <DetailHeader document={d} links={{ category: null, contact: null, ticket: null, deal: null }} actions={documentActions(d, caps)} downloading={null} onView={() => {}} onDownload={() => {}} onVoid={() => {}} />)).not.toContain('role="checkbox"');

      const progress: Pick<StaffProgress, "form" | "roles"> = {
        form: FORM,
        roles: [
          {
            roleKey: "merchant",
            roleLabel: "Merchant",
            signer: { id: "s1", name: "Ali bin Ahmad", email: "ali@x.example", status: "viewed" },
            parts: [
              { key: "company", state: "in_progress", done: 0, total: 1, visible: 1, title: { en: "Company details" } },
              { key: "bank", state: "done", done: 1, total: 1, visible: 1, title: { en: "Bank account" } },
            ],
            percent: 50,
            lastActivityAt: null,
            delegations: [{ part: "bank", name: "Finance Fiona", done: true }],
          },
        ],
      };
      const [view] = roleViews(progress, locale === "ms" ? "ms" : "en");
      const card = page(locale, <RoleProgressCard view={view} role={d.roles_snapshot[0]} device={null} now={Date.parse("2026-10-06T12:00:00Z")} canRemind={false} remindHeldUntil={null} onRemind={() => {}} />);
      expect(card).toContain("Finance Fiona");
    });

    it(`the history carries the new events (${locale})`, () => {
      const signers = [signer({ id: "s1", full_name: "Siti Director", order_no: 2 })];
      const types: [string, Record<string, unknown>][] = [
        ["forwarded", { scope: "turn", from_name: "Ali", to_name: "Siti Director", to_email: "s***@x.example" }],
        ["part_forwarded", { part: "bank", from_name: "Ali", to_name: "Finance Fiona" }],
        ["part_taken_back", { part: "bank", from_name: "Finance Fiona" }],
        ["signer_moved", { from_step: 2, to_step: 3 }],
        ["forwarding_changed", { allow: true }],
        ["forwarding_changed", { allow: false }],
        ["forwarding_changed", {}],
        ["invited", { because: "step_finished", step: 2 }],
        ["invited", { because: "signer_finished", finished_name: "Ali", step: 2 }],
      ];
      const events = types.map(([type, detail], i) => ({ id: `e${i}`, doc_seq: i + 1, signer_id: "s1", type, actor_type: "signer" as const, actor_user_id: null, detail, ip: null, device: null, created_at: "2026-10-06T09:00:00Z" }));
      const html = page(locale, <HistoryView events={events} chain={null} loading={false} failed={false} signers={signers} signInOrder technical form={FORM} />);
      // one line for each event, none a raw key
      expect(html.match(/<li\b/g)).toHaveLength(types.length);
      expect(html).not.toMatch(/Sign\.detail\./);
      if (locale === "en") {
        expect(html).toContain("forwarded their turn to Siti Director");
        expect(html).toContain("forwarded the part Bank account to Finance Fiona");
        expect(html).toContain("was invited because the previous step finished");
        expect(html).toContain("switched forwarding off");
      }
    });
  }
});
