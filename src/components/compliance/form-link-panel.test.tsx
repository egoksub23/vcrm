import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The personal closure form link: the case page's panel and the pieces shared with the raise dialog and the Inbox card, in every language with the real wording
// from messages/<locale>.json (next-intl is told to throw on a missing key). renderToStaticMarkup paints the FIRST render only. NOT covered (no DOM renderer):
// pressing Send again or Withdraw, the clipboard behind Copy link, and the real fetches.

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ capabilities: new Set(["menu.compliance"]) }),
  useCapability: () => true,
}));

import { LINK_STATES } from "@/lib/compliance/chat-link/link-state";
import type { ChatLinkOutcome, FormLinkView } from "@/lib/compliance/chat-link/types";
import { NOT_SENT_REASONS } from "@/lib/compliance/chat-link/types";
import type { RequestDetail } from "@/lib/compliance/types";
import { eventLine } from "./helpers";

import { ChatLinkResult, LinkStateChip } from "./chat-link-parts";
import { FormLinkPanel, linkActions } from "./form-link-panel";

const LOCALES = ["en", "ms", "zh", "ko"] as const;
type Locale = (typeof LOCALES)[number];
type Tree = Record<string, unknown>;
const catalogue = (locale: string): Tree => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Tree;
const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [l, catalogue(l)])) as Record<Locale, Tree>;
const tr = (locale: Locale, namespace: string) => createTranslator({ locale, messages: CATALOGUES[locale] as never, namespace: namespace as never }) as unknown as (key: string, values?: Record<string, unknown>) => string;

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => vi.restoreAllMocks());

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
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const link = (over: Partial<FormLinkView> = {}): FormLinkView => ({
  id: "b1000000-0000-4000-8000-000000000001",
  state: "sent",
  channel: "whatsapp",
  locale: "ms",
  createdAt: "2026-10-13T09:00:00Z",
  expiresAt: "2026-10-27T09:00:00Z",
  sentAt: "2026-10-13T09:01:00Z",
  openedAt: null,
  submittedAt: null,
  revokedAt: null,
  createdBy: { id: "u1", name: "Alia Agent" },
  ...over,
});
const detail = (over: Partial<RequestDetail> = {}): RequestDetail =>
  ({
    id: "r1",
    typeKey: "closure",
    status: "received",
    formLinks: [link()],
    viewer: { userId: "u1", canReview: true, canApprove: false, canReveal: false, canExecute: false, canManage: false },
    ...over,
  }) as unknown as RequestDetail;
const act = async () => true;

describe("which buttons the panel offers", () => {
  it("offers Send again unless the form came back, and Withdraw only while the link can be used", () => {
    const open = { canAct: true, caseOpen: true };
    expect(linkActions([{ state: "sent" }], open)).toEqual({ resend: true, revoke: true });
    expect(linkActions([{ state: "opened" }], open)).toEqual({ resend: true, revoke: true });
    expect(linkActions([{ state: "created" }], open)).toEqual({ resend: true, revoke: true });
    for (const s of ["expired", "revoked", "replaced"] as const) expect(linkActions([{ state: s }], open)).toEqual({ resend: true, revoke: false });
    expect(linkActions([{ state: "submitted" }], open)).toEqual({ resend: false, revoke: false });
    expect(linkActions([], open)).toEqual({ resend: true, revoke: false });
  });

  it("offers nothing to a person who may not act, or once the case is with the Head of Compliance or finished", () => {
    expect(linkActions([{ state: "sent" }], { canAct: false, caseOpen: true })).toEqual({ resend: false, revoke: false });
    expect(linkActions([{ state: "sent" }], { canAct: true, caseOpen: false })).toEqual({ resend: false, revoke: false });
  });

  it("is decided by the newest link", () => {
    expect(linkActions([{ state: "sent" }, { state: "submitted" }], { canAct: true, caseOpen: true })).toEqual({ resend: true, revoke: true });
  });
});

describe.each(LOCALES)("the closure form link panel in %s", (locale) => {
  const t = tr(locale, "Compliance.chatLink");

  it("lists the links with their state, when they were made, sent and opened, and who sent it; never an address", () => {
    const html = page(locale, <FormLinkPanel d={detail({ formLinks: [link({ state: "opened", openedAt: "2026-10-13T10:00:00Z" }), link({ id: "b2", state: "replaced", sentAt: null })] })} act={act} busy={false} now={0} />);
    const s = text(html);
    expect(s).toContain(t("panel.title"));
    expect(s).toContain(t("panel.intro"));
    expect(s).toContain(t("state.opened"));
    expect(s).toContain(t("state.replaced"));
    expect(s).toContain(t("panel.resend"));
    expect(s).toContain(t("panel.revoke"));
    expect(s).toContain(t("panel.resendHelp"));
    expect(s).toContain("Alia Agent");
    expect(html).not.toMatch(/https?:|\/c\/link|token/i);
  });

  it("has no Withdraw once the form came back, and no Send again either", () => {
    const s = text(page(locale, <FormLinkPanel d={detail({ formLinks: [link({ state: "submitted", submittedAt: "2026-10-13T11:00:00Z" })] })} act={act} busy={false} now={0} />));
    expect(s).toContain(t("state.submitted"));
    expect(s).not.toContain(t("panel.resend"));
    expect(s).not.toContain(t("panel.revoke"));
  });

  it("offers to make one for a closure that has none, to a person who may", () => {
    const s = text(page(locale, <FormLinkPanel d={detail({ formLinks: [] })} act={act} busy={false} now={0} />));
    expect(s).toContain(t("panel.empty"));
    expect(s).toContain(t("panel.resend"));
  });

  it("is not on a case that is not a closure, nor for a person who may only look when there is nothing to see", () => {
    expect(page(locale, <FormLinkPanel d={detail({ typeKey: "withdrawal" })} act={act} busy={false} now={0} />)).toBe("");
    const none = detail({ formLinks: [], viewer: { userId: "u1", canReview: false, canApprove: false, canReveal: true, canExecute: false, canManage: false } });
    expect(page(locale, <FormLinkPanel d={none} act={act} busy={false} now={0} />)).toBe("");
  });

  it("does not offer the buttons once the case is past review", () => {
    const s = text(page(locale, <FormLinkPanel d={detail({ status: "awaiting_signoff" })} act={act} busy={false} now={0} />));
    expect(s).toContain(t("state.sent"));
    expect(s).not.toContain(t("panel.resend"));
  });

  it("says every state in words", () => {
    for (const state of LINK_STATES) {
      const html = page(locale, <LinkStateChip state={state} />);
      expect(text(html).trim()).toBe(t(`state.${state}`));
      expect(html).toContain(`data-link-state="${state}"`);
    }
  });

  it("tells the agent what came of sending: a sent card, a sent line, and for every reason a link that was made but not sent, with Copy link", () => {
    const sentCard: ChatLinkOutcome = { status: "sent", linkId: "l", expiresAt: "x", mode: "card", channel: "whatsapp" };
    expect(text(page(locale, <ChatLinkResult outcome={sentCard} />))).toContain(t("outcome.sentCard"));
    expect(text(page(locale, <ChatLinkResult outcome={{ ...sentCard, mode: "text", channel: "vircle_chat" }} />))).toContain(t("outcome.sentText"));
    for (const reason of NOT_SENT_REASONS) {
      const html = page(locale, <ChatLinkResult outcome={{ status: "not_sent", linkId: "l", expiresAt: "x", reason, channel: "whatsapp", url: "https://halo.test/c/link/SECRET" }} />);
      const s = text(html);
      expect(s).toContain(t("outcome.notSent"));
      expect(s).toContain(t(`outcome.reason.${reason}`));
      expect(s).toContain(t("copy"));
      expect(s).toContain(t("copyHint"));
      expect(html).toContain('data-action="copy-link"');
      // the address is not drawn: it is only what the Copy link button puts on the clipboard
      expect(html).not.toContain("SECRET");
    }
    for (const reason of ["not_closure", "no_key", "no_conversation"] as const) expect(text(page(locale, <ChatLinkResult outcome={{ status: "unavailable", reason }} />))).toContain(t(`outcome.unavailable.${reason}`));
  });

  it("paints without a single React warning", () => {
    page(locale, <FormLinkPanel d={detail()} act={act} busy={false} now={0} />);
    expect(errors).toEqual([]);
  });
});

describe("the timeline words for the link", () => {
  it("maps each action to a line with words in every language", () => {
    for (const action of ["minted", "sent", "resent", "opened", "revoked", "not_sent", "something"]) {
      const line = eventLine({ kind: "form_link", detail: { action, channel: "whatsapp", link: "x" } });
      expect(line.key).toBe(`form_link_${action === "something" ? "other" : action}`);
      for (const l of LOCALES) expect(tr(l, "Compliance.timeline.kinds")(line.key).length, `${l} ${line.key}`).toBeGreaterThan(5);
    }
    expect(eventLine({ kind: "form_submitted", detail: {} }).key).toBe("form_submitted");
    for (const l of LOCALES) expect(tr(l, "Compliance.timeline.kinds")("form_submitted").length).toBeGreaterThan(5);
  });

  it("words the new error codes in every language", () => {
    for (const l of LOCALES) for (const code of ["form_link_not_allowed", "form_link_submitted"]) expect(tr(l, "Compliance.errors")(code).length).toBeGreaterThan(10);
  });
});
