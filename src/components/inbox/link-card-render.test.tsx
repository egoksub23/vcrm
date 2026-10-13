import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Render tests for the Compliance requests linked to the Inbox chat (migration 185), in every language, with the real wording from messages/<locale>.json
// (next-intl is told to throw on a missing key):
//   the two-section ticket column for each role (a holder of the Compliance menu sees links; a person who only raised sees plain rows; no rows shows each
//   section's own empty state; Compliance off draws no compliance section at all)
//   the closure form card in the thread for every status, a failed card without Resend, the card with Send again / Withdraw, and that no address is ever in
//   the markup
//   the internal note "Closure form submitted . CMP-..." and the reply-quote preview of a card
// renderToStaticMarkup paints the FIRST render only. NOT covered (no DOM renderer): clicking Send again or Withdraw and the Copy link that follows, the 30 s and
// 60 s polling timers and the tab-visibility refresh, the focus order, and the two sections scrolling independently (the classes that do it are asserted, the
// scrolling is not).

const state = vi.hoisted(() => ({
  caps: new Set<string>(),
  platform: { status: "active", plan: "standard", limits: {}, features: {} as Record<string, boolean>, suspendedReason: null, deletionDueAt: null },
}));

vi.mock("@/hooks/use-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-auth")>();
  return {
    ...actual,
    useAuth: () => ({ user: { id: "u1", email: "agent@example.test" }, accountId: "a1", platform: state.platform }),
    useCapability: (cap: string) => state.caps.has(cap),
  };
});
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
// the ticket dialogs and the SLA badge are not what is under test (they hold their own hooks and fetches)
vi.mock("@/components/tickets/create-ticket-dialog", () => ({ CreateTicketDialog: () => null }));
vi.mock("@/components/tickets/ticket-detail-dialog", () => ({ TicketDetailDialog: () => null }));
vi.mock("@/components/tickets/ticket-sla-badge", () => ({ TicketSlaBadge: () => null }));

import { storedCard } from "@/lib/compliance/chat-link/card";
import { LINK_STATES, type LinkState } from "@/lib/compliance/chat-link/link-state";
import type { CardStatus } from "@/lib/compliance/chat-link/types";
import type { Message } from "@/types";

import { CardStatusContext } from "./card-status";
import type { LinkedHeld } from "./linked-compliance";
import { MessageBubble } from "./message-bubble";
import { buildReplyPreview } from "./reply-quote";
import { TicketHistoryPanel } from "./ticket-history-panel";

const LOCALES = ["en", "ms", "zh", "ko"] as const;
type Locale = (typeof LOCALES)[number];
type Tree = Record<string, unknown>;
const catalogue = (locale: string): Tree => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Tree;
const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [l, catalogue(l)])) as Record<Locale, Tree>;
const tr = (locale: Locale, namespace: string) => createTranslator({ locale, messages: CATALOGUES[locale] as never, namespace: namespace as never }) as unknown as (key: string, values?: Record<string, unknown>) => string;

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  state.caps = new Set();
  state.platform = { status: "active", plan: "standard", limits: {}, features: { compliance: true }, suspendedReason: null, deletionDueAt: null };
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(errors).toEqual([]);
});

function page(locale: Locale, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={CATALOGUES[locale] as never}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
/** The markup without the SVG namespace attribute every icon carries (it is not an address). */
const noNs = (html: string) => html.replace(/ xmlns="[^"]*"/g, "");

// ---- the ticket column ------------------------------------------------------------------------------------------------------------

const ID_A = "3b241101-e2bb-4255-8caf-4136c566a962";
const ID_B = "9a5fd0ea-6b12-4c8e-9f0b-0a7d3a5f6c11";
type Initial = NonNullable<Parameters<typeof TicketHistoryPanel>[0]["initial"]>;

const NAMES = { ms: "Penutupan akaun", zh: "关闭账户", ko: "계정 해지", en: "Account closure" } as const;
const raised = (over: Record<string, unknown> = {}) => ({
  reference: "CMP-2026-000014",
  typeKey: "closure",
  typeLabel: "Account closure",
  typeLabelL10n: { ms: NAMES.ms, zh: NAMES.zh, ko: NAMES.ko },
  status: "in_review",
  raisedAt: "2026-10-12T08:00:00Z",
  ...over,
});
const held = (items: unknown[], enabled = true): LinkedHeld => ({ conversationId: "c1", enabled, items: items as LinkedHeld["items"] });
const TWO = [raised({ id: ID_A }), raised({ id: ID_B, reference: "CMP-2026-000009", status: "done" })];

const ticket = {
  id: "t1",
  ticket_number: 7,
  subject: "Cannot log in",
  status: "closed",
  priority: "normal",
  category: "technical",
  conversation_id: "c1",
  created_at: "2026-10-01T08:00:00Z",
  updated_at: "2026-10-01T08:00:00Z",
  sla_policy_id: null,
  sla_first_response_due_at: null,
  sla_first_response_risk_at: null,
  sla_first_response_state: null,
  sla_resolution_due_at: null,
  sla_resolution_risk_at: null,
  sla_resolution_state: null,
} as unknown as NonNullable<Initial["rows"]>[number];

const column = (locale: Locale, initial: Initial) => page(locale, <TicketHistoryPanel contactId="ct1" conversationId="c1" initial={initial} />);
const complianceHtml = (html: string) => html.slice(html.indexOf('data-testid="compliance-section"'));

describe.each(LOCALES)("the ticket column, %s", (locale) => {
  const th = tr(locale, "Inbox.ticketHistory");
  const raise = tr(locale, "Compliance.raise");

  it("draws two sections: General tickets (as before) and Compliance requests, with counts and a divider", () => {
    state.caps = new Set(["menu.compliance", "tickets.work"]);
    const html = column(locale, { rows: [ticket], linked: held(TWO) });
    const t = text(html);
    expect(t).toContain(th("generalTitle"));
    expect(t).toContain(th("summary", { total: 1, active: 0 }));
    expect(t).toContain(th("complianceTitle"));
    expect(t).toContain(th("complianceSummary", { total: 2, open: 1 }));
    expect(t).toContain("Cannot log in");
    // the Raise button stays in the tickets header, and the all/active/done filters with it
    expect(t).toContain(th("raise"));
    for (const f of ["all", "active", "done"]) expect(t).toContain(th(`filter.${f}`));
    // both sections are visible at once, with a divider, and each scrolls on its own
    expect(html.match(/data-testid="(tickets|compliance)-section"/g)).toHaveLength(2);
    expect(html).toContain("border-t-2");
    expect(html.match(/overflow-y-auto/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain(`>${th("title")}<`); // "Ticket history" is the name only when there is no second section
  });

  it("a holder of the Compliance menu sees every request, each row a link to its case", () => {
    state.caps = new Set(["menu.compliance"]);
    const html = complianceHtml(column(locale, { rows: [], linked: held(TWO) }));
    expect(html).toContain(`href="/compliance/${ID_A}"`);
    expect(html).toContain(`href="/compliance/${ID_B}"`);
    const t = text(html);
    expect(t).toContain("CMP-2026-000014");
    expect(t).toContain("CMP-2026-000009");
    expect(t).toContain(NAMES[locale]); // the type, in the person's language
    expect(t).toContain(raise("status.in_review"));
    expect(t).toContain(raise("status.done"));
    expect(html).toContain("font-mono"); // the reference is monospace
    expect(html).toContain('data-status="in_review"');
  });

  it("a person who only raised sees plain rows: reference, type and status, never a link or customer data", () => {
    state.caps = new Set(["compliance.raise"]);
    // what the server sends such a person: no id, nothing else. A decoy of extra fields proves the screen would not show them anyway.
    const minimal = [raised({ customerName: "Siti Aminah", customerPhone: "+60123456789", step: "awaiting_signoff" })];
    const html = complianceHtml(column(locale, { rows: [], linked: held(minimal) }));
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("/compliance/");
    const t = text(html);
    expect(t).toContain("CMP-2026-000014");
    expect(t).toContain(NAMES[locale]);
    expect(t).toContain(raise("status.in_review"));
    for (const secret of ["Siti", "60123456789", "awaiting_signoff", "Awaiting sign-off"]) expect(html).not.toContain(secret);
  });

  it("a row is plain text even if an id arrived, when the person lacks the Compliance menu", () => {
    state.caps = new Set(["compliance.raise", "compliance.review"]);
    const html = complianceHtml(column(locale, { rows: [], linked: held([raised({ id: ID_A })]) }));
    expect(html).not.toContain("href=");
    expect(html).not.toContain(ID_A);
  });

  it("with no rows each section shows its own empty state", () => {
    state.caps = new Set(["menu.compliance"]);
    const html = column(locale, { rows: [], linked: held([]) });
    const t = text(html);
    expect(t).toContain(th("none")); // no tickets
    expect(t).toContain(th("empty"));
    expect(t).toContain(th("complianceNone"));
    expect(t).toContain(th("complianceEmpty"));
    expect(html.match(/data-testid="compliance-row"/g)).toBeNull();
  });

  it("with Compliance off in the workspace the compliance section is not drawn at all", () => {
    state.caps = new Set(["menu.compliance"]);
    state.platform.features = {}; // Compliance reads as off unless the operator turned it on
    const html = column(locale, { rows: [ticket], linked: held(TWO) });
    expect(html).not.toContain("compliance-section");
    expect(html).not.toContain("/compliance/");
    const t = text(html);
    expect(t).not.toContain(th("complianceTitle"));
    expect(t).toContain(th("title")); // the column is exactly what it was: Ticket history
    expect(t).not.toContain(th("generalTitle"));
    expect(t).toContain(th("summary", { total: 1, active: 0 }));
    expect(html.match(/data-testid="tickets-section"/g)).toHaveLength(1);
    expect(html).not.toContain("border-t-2");
  });

  it("with the flag on here but the server saying Compliance is off, the section is not drawn either", () => {
    state.caps = new Set(["menu.compliance"]);
    const html = column(locale, { rows: [], linked: held([], false) });
    expect(html).not.toContain("compliance-section");
    expect(text(html)).toContain(th("title"));
  });

  it("while the first answer is awaited the section shows a loading state, not rows", () => {
    state.caps = new Set(["menu.compliance"]);
    const html = column(locale, { rows: [] });
    expect(html).toContain("compliance-section");
    expect(html).toContain(`aria-label="${th("complianceLoading")}"`);
    expect(html).not.toContain('data-testid="compliance-row"');
  });
});

// ---- the card in the thread -------------------------------------------------------------------------------------------------------

const LINK = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const cardStatus = (state: LinkState, over: Partial<CardStatus> = {}): CardStatus => ({ id: LINK, state, expiresAt: "2026-10-26T08:00:00Z", canManage: false, ...over });

const cardMessage = (locale: Locale, over: Partial<Message> = {}): Message =>
  ({
    id: "m1",
    conversation_id: "c1",
    sender_type: "agent",
    sender_id: "u1",
    content_type: "link_card",
    content_text: storedCard(LINK, locale).title,
    channel_type: "whatsapp",
    status: "delivered",
    created_at: "2026-10-12T10:00:00.000Z",
    send_payload: { link_card: storedCard(LINK, locale) },
    ...over,
  }) as Message;

function card(locale: Locale, message: Message, status: CardStatus | null, extra: Partial<React.ComponentProps<typeof MessageBubble>> = {}) {
  const value = { byLink: new Map(status ? [[status.id, status]] : []), refresh: async () => undefined };
  return page(
    locale,
    <CardStatusContext.Provider value={value}>
      <MessageBubble message={message} {...extra} />
    </CardStatusContext.Provider>,
  );
}

describe.each(LOCALES)("the closure form card, %s", (locale) => {
  const words = storedCard(LINK, locale);
  const chip = tr(locale, "Compliance.chatLink.state");
  const lc = tr(locale, "Inbox.linkCard");

  it.each(LINK_STATES)("draws a card (not a bubble of raw text) for the %s state, with the button as a picture", (st) => {
    const html = card(locale, cardMessage(locale), cardStatus(st));
    const t = text(html);
    expect(html).toContain('data-testid="link-card"');
    expect(t).toContain(words.title);
    expect(t).toContain(words.body);
    expect(t).toContain(words.button);
    expect(t).toContain(chip(st)); // the status, in words
    expect(html).toContain(`data-link-state="${st}"`);
    expect(t).toContain(lc("statusLabel"));
    // the button is not pressable, not in the tab order, and not a link
    const button = /<button[^>]*data-testid="link-card-button"[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).toContain("disabled");
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain('tabindex="-1"');
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    // never an address
    expect(noNs(html)).not.toContain("http");
    expect(html).not.toContain("/c/link/");
    expect(t).not.toContain("link_card");
    expect(t.toLowerCase()).not.toContain("envelope");
    // the message's own time and tick are still there
    expect(html).toMatch(/\d\d:\d\d/);
  });

  it("shows no status line and no buttons to a person who may not read statuses", () => {
    const html = card(locale, cardMessage(locale), null);
    expect(html).toContain('data-testid="link-card"');
    expect(html).not.toContain("data-link-state");
    expect(html).not.toContain('data-testid="link-card-status"');
    expect(html).not.toContain("link-card-resend");
    expect(html).not.toContain("link-card-withdraw");
    expect(noNs(html)).not.toContain("http");
  });

  it("offers no buttons when canManage is false", () => {
    const html = card(locale, cardMessage(locale), cardStatus("sent", { canManage: false, requestId: REQ }));
    expect(html).not.toContain("link-card-resend");
    expect(html).not.toContain("link-card-withdraw");
  });

  it("offers Send again and Withdraw while the link can still be used, when canManage is true", () => {
    for (const st of ["created", "sent", "opened"] as const) {
      const html = card(locale, cardMessage(locale), cardStatus(st, { canManage: true, requestId: REQ }));
      const t = text(html);
      expect(html).toContain('data-testid="link-card-resend"');
      expect(html).toContain('data-testid="link-card-withdraw"');
      expect(t).toContain(lc("resend"));
      expect(t).toContain(lc("withdraw"));
      expect(html).not.toContain(REQ); // the request id is never printed
      expect(noNs(html)).not.toContain("http");
    }
  });

  it("offers only Send again once the link has ended, and nothing once it was submitted or replaced", () => {
    for (const st of ["expired", "revoked"] as const) {
      const html = card(locale, cardMessage(locale), cardStatus(st, { canManage: true, requestId: REQ }));
      expect(html).toContain("link-card-resend");
      expect(html).not.toContain("link-card-withdraw");
    }
    for (const st of ["submitted", "replaced"] as const) {
      const html = card(locale, cardMessage(locale), cardStatus(st, { canManage: true, requestId: REQ }));
      expect(html).not.toContain("link-card-resend");
      expect(html).not.toContain("link-card-withdraw");
    }
  });

  it("a card that failed to send shows the failed notice WITHOUT Resend, and says where to send again", () => {
    const failed = cardMessage(locale, { status: "failed", error_code: 131047, error_title: "Re-engagement message", error_details: null });
    // even when the thread hands a resend callback over, the card never offers the generic Resend
    const html = card(locale, failed, cardStatus("created", { canManage: true, requestId: REQ }), { onResend: () => undefined, onDeleteFailed: () => undefined });
    const t = text(html);
    expect(html).toContain('data-testid="failed-message-notice"');
    expect(t).toContain(tr(locale, "Inbox.failure")("notSent"));
    expect(html).not.toContain("failed-message-resend");
    expect(html).toContain('data-testid="failed-message-delete"');
    expect(html).toContain('data-testid="failed-message-hint"');
    expect(t).toContain(lc("failedHint"));
    // Send again on the card itself is there
    expect(html).toContain("link-card-resend");
    expect(html).toContain("ring-red-500");
    expect(noNs(html)).not.toContain("http");
  });

  it("a row with its words missing still draws, with the title from the message text and no status", () => {
    const html = card(locale, cardMessage(locale, { send_payload: null, content_text: "Account closure form" }), cardStatus("sent"));
    expect(html).toContain("Account closure form");
    expect(html).not.toContain("link-card-button");
    expect(html).not.toContain("data-link-state");
  });

  it("an inbound-looking card row and a reply quote do not break the card", () => {
    const html = card(locale, cardMessage(locale), null, { reply: { authorLabel: "Ada", preview: "hello" }, senderLabel: "Olivia" });
    expect(text(html)).toContain("hello");
    expect(text(html)).toContain("Olivia");
  });
});

describe("the Resend path of the thread", () => {
  it("a failed ordinary message still gets Resend (only the card does not)", () => {
    state.caps = new Set(["messages.send"]);
    const html = page(
      "en",
      <MessageBubble
        message={{ id: "m2", conversation_id: "c1", sender_type: "agent", content_type: "text", content_text: "Hello", channel_type: "whatsapp", status: "failed", created_at: "2026-10-12T10:00:00.000Z", error_title: "x" } as Message}
        onResend={() => undefined}
      />,
    );
    expect(html).toContain("failed-message-resend");
  });
});

// ---- the internal note and the reply quote ----------------------------------------------------------------------------------------

describe("the notes on the conversation", () => {
  const note = (content_text: string): Message =>
    ({ id: "n1", conversation_id: "c1", sender_type: "agent", sender_id: "u1", content_type: "text", content_text, is_internal: true, channel_type: "whatsapp", status: "sent", created_at: "2026-10-12T10:00:00.000Z" }) as Message;

  it("the reference in 'Closure form submitted . CMP-...' is a link only for a holder of the Compliance menu", () => {
    const text1 = "Closure form submitted · CMP-2026-000014";
    state.caps = new Set(["menu.compliance"]);
    const html = page("en", <MessageBubble message={note(text1)} />);
    expect(html).toContain('href="/compliance?q=CMP-2026-000014"');
    expect(text(html)).toContain("Closure form submitted · CMP-2026-000014");
    state.caps = new Set();
    const plain = page("en", <MessageBubble message={note(text1)} />);
    expect(plain).not.toContain("href=");
    expect(text(plain)).toContain(text1);
    // and the older note text still behaves
    state.caps = new Set(["menu.compliance"]);
    expect(page("en", <MessageBubble message={note("Compliance request CMP-2026-000014 raised")} />)).toContain('href="/compliance?q=CMP-2026-000014"');
  });
});

describe("the reply-quote preview of a card", () => {
  const t = tr("en", "Inbox.replyQuote") as unknown as Parameters<typeof buildReplyPreview>[1];
  it("is the card's title, and the generic word when the row has no text", () => {
    expect(buildReplyPreview(cardMessage("en"), t)).toBe("Account closure form");
    expect(buildReplyPreview(cardMessage("en", { content_text: undefined }), t)).toBe("[Message]");
    expect(buildReplyPreview(cardMessage("en"), t)).not.toContain("link_card");
  });
});
