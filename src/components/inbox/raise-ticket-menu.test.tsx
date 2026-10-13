import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Render tests for the Inbox header's single "Raise ticket" control, in every language with the real catalogues (next-intl throws on a missing key): the menu
// when the person holds compliance.raise, the old single button when the capability is gone (the workspace's compliance flag is off), the read-only
// behaviour, and the entries the menu offers.
// NOT covered (no DOM renderer; renderToStaticMarkup paints only the first render, and a closed menu's popup is not in it): opening the menu, arrow keys and
// Enter on its entries, focus returning to the button, an entry opening the ticket or the compliance dialog, and how the popup sits at 360 px wide (it is
// w-64 capped at the viewport width less 1rem, entries wrap; check by eye on a phone-width window).

const caps = vi.hoisted(() => ({ held: new Set<string>() }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "u1", email: "agent@example.test" }, profile: { full_name: "Agent", email: "agent@example.test" }, capabilities: caps.held, refreshCapabilities: () => undefined }),
  useCapability: (cap: string) => caps.held.has(cap),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

import { RaiseTicketMenu, raiseMenuEntries } from "./raise-ticket-menu";

const LOCALES = ["en", "ms", "zh", "ko"] as const;
type Locale = (typeof LOCALES)[number];
type Tree = Record<string, unknown>;
const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(readFileSync(join(process.cwd(), "messages", `${l}.json`), "utf8")) as Tree])) as Record<Locale, Tree>;
const tr = (locale: Locale, namespace: string) => createTranslator({ locale, messages: CATALOGUES[locale] as never, namespace: namespace as never }) as unknown as (key: string) => string;

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  caps.held = new Set();
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => vi.restoreAllMocks());

function menu(locale: Locale, props: { canWorkTickets?: boolean } = {}) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={CATALOGUES[locale] as never}
      onError={(e) => {
        throw e;
      }}
    >
      <RaiseTicketMenu conversationId="cv1" canWorkTickets={props.canWorkTickets ?? true} onRaiseTicket={() => undefined} />
    </NextIntlClientProvider>,
  );
}
const isDisabled = (tag: string) => /\sdisabled(=|\s|>)/.test(tag);
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);

describe("raiseMenuEntries", () => {
  it("offers the ticket alone while compliance is unavailable, and the compliance request after it while it is", () => {
    expect(raiseMenuEntries(false, true).map((e) => e.key)).toEqual(["technical"]);
    expect(raiseMenuEntries(true, true).map((e) => e.key)).toEqual(["technical", "compliance"]);
  });
  it("switches the ticket entry off, with the read-only reason, for a person who may not work tickets, and leaves the compliance entry alone", () => {
    const [ticket, compliance] = raiseMenuEntries(true, false);
    expect(ticket.disabled).toBe(true);
    expect(ticket.reason).toMatch(/Read-only/);
    expect(compliance).toEqual({ key: "compliance", disabled: false });
    expect(raiseMenuEntries(true, true)[0]).toEqual({ key: "technical", disabled: false });
  });
});

describe.each(LOCALES)("the Raise ticket control in %s", (locale) => {
  const label = tr(locale, "Inbox.messageThread")("raiseTicket");

  it("is a menu button, labelled for assistive technology on a narrow screen, while the person may raise a compliance request", () => {
    caps.held = new Set(["compliance.raise"]);
    const html = menu(locale);
    const [button] = buttons(html);
    expect(button).toContain(`aria-label="${label}"`);
    expect(button).toContain(`title="${label}"`);
    expect(button).toContain('aria-haspopup="menu"');
    expect(html).toContain(`<span class="hidden sm:inline">${label}</span>`);
    expect(errors).toEqual([]);
  });

  it("is the old single button, with no menu, when compliance.raise is not held", () => {
    caps.held = new Set(["menu.compliance"]);
    const html = menu(locale);
    const all = buttons(html);
    expect(all).toHaveLength(1);
    expect(all[0]).not.toContain("aria-haspopup");
    expect(all[0]).toContain(`aria-label="${label}"`);
    expect(all[0]).toContain(`title="${label}"`);
    expect(isDisabled(all[0])).toBe(false);
    expect(html).toContain(`<span class="hidden sm:inline">${label}</span>`);
    expect(errors).toEqual([]);
  });

  it("keeps the old single button's read-only behaviour: disabled, with the reason as its title", () => {
    const html = menu(locale, { canWorkTickets: false });
    const [button] = buttons(html);
    expect(isDisabled(button)).toBe(true);
    expect(button).toContain("Read-only");
    expect(button).toContain(`aria-label="${label}"`);
  });

  it("does not disable the menu itself for a person who may not work tickets (the compliance request is still theirs to raise)", () => {
    caps.held = new Set(["compliance.raise"]);
    const [button] = buttons(menu(locale, { canWorkTickets: false }));
    expect(isDisabled(button)).toBe(false);
    expect(button).toContain('aria-haspopup="menu"');
  });

  it("has the entries' words in the language (nothing is left as a key)", () => {
    const t = tr(locale, "Inbox.raiseMenu");
    expect(t("technical").length).toBeGreaterThan(3);
    expect(t("compliance").length).toBeGreaterThan(3);
    expect(t("technical")).not.toBe(t("compliance"));
  });
});
