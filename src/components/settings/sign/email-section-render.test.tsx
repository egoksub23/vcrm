import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// Settings > Doc Sign > General > Email: the status card, first paint, in every language, with the screens' real messages. Which way email goes
// (Microsoft 365 mailbox, Gmail mailbox, the platform sender, not set up, a mailbox with a problem), the link to where the mailbox is connected,
// and the outcome of the test email. Read only: there is no setting on the card.

vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));

import type { EmailStatus, TestEmailResult } from "@/lib/sign/service/email-status";
import { CHANNEL_LINK, EmailStatusCard, type TestState } from "./email-section";

const LOCALES = ["en", "ms", "zh", "ko"] as const;
type Tree = Record<string, unknown>;
const signMessages = (locale: string) => (JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sign: Tree }).Sign;
const text = (locale: string, path: string) => path.split(".").reduce<unknown>((n, k) => (n as Tree)[k], signMessages(locale)) as string;
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => v[k] ?? `{${k}}`);
const clean = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<!-- -->/g, "");

function render(locale: string, email: EmailStatus, test: TestState = { status: "idle" }, canEdit = true) {
  return clean(
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} timeZone="UTC" messages={{ Sign: signMessages(locale) }} onError={(e) => { throw e; }}>
        <EmailStatusCard email={email} canEdit={canEdit} test={test} onTest={() => undefined} />
      </NextIntlClientProvider>,
    ),
  );
}

const status = (over: Partial<EmailStatus>): EmailStatus => ({ via: "none", provider: null, address: null, problem: null, fromName: "Vircle", ...over });
const ms = status({ via: "mailbox", provider: "microsoft365", address: "support@vircle.com" });
const gmail = status({ via: "mailbox", provider: "gmail", address: "sales@vircle.com" });
const result = (over: Partial<TestEmailResult>): TestEmailResult => ({ sent: true, via: "mailbox", provider: "microsoft365", from: "support@vircle.com", to: "me@vircle.com", reason: null, detail: null, ...over });

describe.each(LOCALES)("the Email card (%s)", (locale) => {
  it("names the Microsoft 365 mailbox it sends from, the name people see, and links to where it is connected", () => {
    const out = render(locale, ms);
    expect(out).toContain(fill(text(locale, "admin.email.transport.microsoft365"), { address: "support@vircle.com" }));
    expect(out).toContain(fill(text(locale, "admin.email.nameNote"), { name: "Vircle" }));
    expect(out).toContain(text(locale, "admin.email.keptNote.microsoft365"));
    expect(out).toContain(text(locale, "admin.email.inboxNote"));
    // the mailbox is used for Secure Sign even when it is switched off as the customer care inbox
    expect(out).toContain(text(locale, "admin.email.inboxOffNote"));
    expect(out).toContain(`href="${CHANNEL_LINK.microsoft365}"`);
    expect(out).toContain(text(locale, "admin.email.link.manage"));
    expect(out).toContain('data-email-via="mailbox"');
  });

  it("names a Gmail mailbox the same way, with its own link and its own note on the Sent folder", () => {
    const out = render(locale, gmail);
    expect(out).toContain(fill(text(locale, "admin.email.transport.gmail"), { address: "sales@vircle.com" }));
    expect(out).toContain(text(locale, "admin.email.keptNote.gmail"));
    expect(out).toContain(`href="${CHANNEL_LINK.gmail}"`);
    expect(out).not.toContain(text(locale, "admin.email.keptNote.microsoft365"));
  });

  it("says the platform sender is used, and offers both ways to connect a mailbox", () => {
    const out = render(locale, status({ via: "platform" }));
    expect(out).toContain(text(locale, "admin.email.transport.platform"));
    expect(out).toContain(text(locale, "admin.email.platformNote"));
    expect(out).toContain(`href="${CHANNEL_LINK.microsoft365}"`);
    expect(out).toContain(`href="${CHANNEL_LINK.gmail}"`);
  });

  it("says a connected mailbox that cannot send is why the platform sender is used, and links to it", () => {
    const out = render(locale, status({ via: "platform", provider: "microsoft365", address: "support@vircle.com", problem: "reconnect" }));
    expect(out).toContain(fill(text(locale, "admin.email.problem.reconnect"), { address: "support@vircle.com" }));
    expect(out).toContain(text(locale, "admin.email.platformInstead"));
    expect(out).toContain(`href="${CHANNEL_LINK.microsoft365}"`);
    expect(out).not.toContain(text(locale, "admin.email.platformNote"));
  });

  it("says it is not set up, and where to connect a mailbox", () => {
    const out = render(locale, status({ via: "none" }));
    expect(out).toContain(text(locale, "admin.email.transport.none"));
    expect(out).toContain(text(locale, "admin.email.link.connectMicrosoft365"));
    expect(out).toContain(text(locale, "admin.email.link.connectGmail"));
  });

  it("says email cannot be sent when the only mailbox has a problem, and what the problem is", () => {
    const out = render(locale, status({ via: "none", provider: "gmail", address: "sales@vircle.com", problem: "paused" }));
    expect(out).toContain(text(locale, "admin.email.transport.noneProblem"));
    expect(out).toContain(fill(text(locale, "admin.email.problem.paused"), { address: "sales@vircle.com" }));
    expect(out).toContain(`href="${CHANNEL_LINK.gmail}"`);
  });

  it("has the test button for people who may change settings, and not for others", () => {
    expect(render(locale, ms)).toContain(text(locale, "admin.email.test.button"));
    expect(render(locale, ms, { status: "idle" }, false)).not.toContain(text(locale, "admin.email.test.button"));
  });

  it("says the test email went, from where", () => {
    expect(render(locale, ms, { status: "done", result: result({}) })).toContain(fill(text(locale, "admin.email.test.sentMailbox"), { to: "me@vircle.com", from: "support@vircle.com" }));
    expect(render(locale, status({ via: "platform" }), { status: "done", result: result({ via: "platform", provider: null, from: null }) })).toContain(fill(text(locale, "admin.email.test.sentPlatform"), { to: "me@vircle.com" }));
  });

  it("says why the test email did not go, in words, with a named reason or the service's own", () => {
    const named = render(locale, ms, { status: "done", result: result({ sent: false, reason: "daily_limit", detail: "Daily user sending quota exceeded." }) });
    expect(named).toContain(text(locale, "admin.email.test.failed"));
    expect(named).toContain(text(locale, "delivery.reasons.daily_limit"));
    const unnamed = render(locale, ms, { status: "done", result: result({ sent: false, reason: null, detail: "MailboxNotEnabledForRESTAPI" }) });
    expect(unnamed).toContain("MailboxNotEnabledForRESTAPI");
  });

  it("says a failed request in words, never a raw code", () => {
    const out = render(locale, ms, { status: "error", error: new Error("boom") });
    expect(out).toContain(text(locale, "admin.errors.generic"));
    expect(render(locale, ms)).not.toMatch(/admin\.email|Sign\.admin/);
  });
});

describe("every language has the same words as English", () => {
  it("has the same keys and placeholders for the card", () => {
    const flat = (n: Tree, p = ""): Record<string, string> => Object.fromEntries(Object.entries(n).flatMap(([k, v]) => (typeof v === "object" && v !== null ? Object.entries(flat(v as Tree, `${p}${k}.`)) : [[`${p}${k}`, String(v)]])));
    const en = flat((signMessages("en").admin as Tree).email as Tree);
    for (const locale of LOCALES) {
      const other = flat((signMessages(locale).admin as Tree).email as Tree);
      expect(Object.keys(other).sort()).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en)) expect([...other[k].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), `${locale}.${k}`).toEqual([...en[k].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort());
    }
  });
});
