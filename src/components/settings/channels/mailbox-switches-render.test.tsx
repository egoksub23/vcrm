import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import en from "../../../../messages/en.json";
import ko from "../../../../messages/ko.json";
import ms from "../../../../messages/ms.json";
import zh from "../../../../messages/zh.json";

// Settings > Channels > Email and > Gmail: the two independent controls of a connected mailbox, first paint, in every language, with the screens' real
// messages. "Customer care inbox" is a switch; "Send Halo emails from this mailbox" is a status line, not a switch; "Pause this mailbox completely" is the
// master switch. The switches save through the channel's PATCH route (lib/inbox/mailbox-switch-client.ts has its own tests).

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/use-mail-inbox", () => ({ invalidateMailInbox: () => undefined }));

import { MailboxSwitches, type MailboxSwitchState } from "./mailbox-switches";

const LOCALES = ["en", "ms", "zh", "ko"] as const;
const all = { en, ms, zh, ko } as const;
type Tree = Record<string, unknown>;
const text = (locale: (typeof LOCALES)[number], path: string) => path.split(".").reduce<unknown>((n, k) => (n as Tree)[k], (all[locale] as unknown as Tree).Settings && ((all[locale] as unknown as Tree).Settings as Tree)) as string;
const t = (locale: (typeof LOCALES)[number], key: string) => text(locale, `channels.mailbox.${key}`);
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => v[k] ?? `{${k}}`);
const clean = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<!-- -->/g, "");

function render(locale: (typeof LOCALES)[number], mailbox: MailboxSwitchState, over: Partial<React.ComponentProps<typeof MailboxSwitches>> = {}) {
  return clean(
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} timeZone="UTC" messages={all[locale] as never} onError={(e) => { throw e; }}>
        <MailboxSwitches patchUrl="/api/account/channels/email" idPrefix="email" mailbox={mailbox} address="support@vircle.com" onChange={() => undefined} {...over} />
      </NextIntlClientProvider>,
    ),
  );
}

/** The state of the switches in the order they appear: the customer care inbox, then the pause. */
const switches = (out: string) => [...out.matchAll(/role="switch"[^>]*aria-checked="(true|false)"/g)].map((m) => m[1] === "true");
const disabledSwitches = (out: string) => [...out.matchAll(/<span[^>]*role="switch"[^>]*>/g)].filter((m) => m[0].includes('aria-disabled="true"')).length;

const ok: MailboxSwitchState = { status: "connected", needs_reauth: false, enabled: true, inbox_enabled: true };

describe.each(LOCALES)("the mailbox switches (%s)", (locale) => {
  it("shows the customer care inbox switch on, with its plain description, and the send line as used, naming the mailbox", () => {
    const out = render(locale, ok);
    expect(out).toContain(t(locale, "inboxTitle"));
    expect(out).toContain(t(locale, "inboxDescription"));
    expect(out).toContain(t(locale, "sendTitle"));
    expect(out).toContain(t(locale, "send.used"));
    expect(out).toContain(fill(t(locale, "sendDescription"), { mailbox: "support@vircle.com" }));
    expect(out).toContain(t(locale, "pauseTitle"));
    expect(out).toContain(t(locale, "pauseDescription"));
    expect(out).toContain('data-send-line="used"');
    // the inbox-off warning is not shown while the inbox is on
    expect(out).not.toContain("data-inbox-off");
    expect(out).not.toContain(t(locale, "inboxOffNote"));
  });

  it("has exactly two switches that save (the inbox and the pause) and the send line is not one", () => {
    const out = render(locale, ok);
    expect(out.match(/role="switch"/g)?.length).toBe(2);
    expect(out).toContain('id="email-inbox"');
    expect(out).toContain('id="email-pause"');
    // the inbox switch is on, the pause is off
    expect(switches(out)).toEqual([true, false]);
  });

  it("says the inbox is off - and still that Halo's emails are sent from the mailbox - when only the inbox is switched off", () => {
    const out = render(locale, { ...ok, inbox_enabled: false });
    expect(out).toContain("data-inbox-off");
    expect(out).toContain(t(locale, "inboxOffNote"));
    expect(out).toContain(t(locale, "send.used"));
    expect(out).toContain('data-send-line="used"');
    expect(switches(out)).toEqual([false, false]);
  });

  it("says why Halo's emails are not sent from the mailbox when it is paused, and shows the pause switch on", () => {
    const out = render(locale, { ...ok, enabled: false });
    expect(out).toContain(t(locale, "send.paused"));
    expect(out).not.toContain(t(locale, "send.used"));
    expect(out).toContain('data-send-line="paused"');
    // the inbox switch is its own: still on
    expect(switches(out)).toEqual([true, true]);
  });

  it("says the mailbox needs reconnecting when it does, whatever the pause says", () => {
    const out = render(locale, { ...ok, needs_reauth: true, enabled: false });
    expect(out).toContain(t(locale, "send.reconnect"));
    expect(out).toContain('data-send-line="reconnect"');
  });

  it("disables both switches for someone who cannot manage channels", () => {
    const out = render(locale, ok, { disabled: true });
    expect(disabledSwitches(out)).toBe(2);
    expect(disabledSwitches(render(locale, ok))).toBe(0);
  });

  it("reads without an address when there is none", () => {
    const out = render(locale, ok, { address: null });
    expect(out).toContain(t(locale, "sendDescriptionNoAddress"));
  });

  it("shows a provider's own words under the inbox switch while it is on, and hides them when it is off", () => {
    const extra = <span data-provider-extra>extra words</span>;
    expect(render(locale, ok, { extra })).toContain("data-provider-extra");
    expect(render(locale, { ...ok, inbox_enabled: false }, { extra })).not.toContain("data-provider-extra");
  });
});

describe("the words are the same on every language, and every key exists in each", () => {
  const KEYS = [
    "inboxTitle", "inboxDescription", "inboxOffNote", "on", "off", "inboxOnToast", "inboxOffToast", "inboxOffStopFailed", "inboxOnNoPush",
    "sendTitle", "send.used", "send.paused", "send.reconnect", "sendDescription", "sendDescriptionNoAddress",
    "pauseTitle", "pauseDescription", "pausedToast", "resumedToast",
    "refusal.needs_reconnect", "refusal.start_failed", "refusal.not_connected", "refusal.failed",
  ];
  it.each(LOCALES)("%s has them all, with the same placeholders as English", (locale) => {
    for (const key of KEYS) {
      const v = t(locale, key);
      expect(typeof v, `${locale} ${key}`).toBe("string");
      expect(v.length, `${locale} ${key}`).toBeGreaterThan(0);
      const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
      expect(holes(v), `${locale} ${key}`).toBe(holes(t("en", key)));
    }
  });

  it("names the three controls as the owner's words (English)", () => {
    expect(t("en", "inboxTitle")).toBe("Customer care inbox");
    expect(t("en", "sendTitle")).toBe("Send Halo emails from this mailbox");
    expect(t("en", "send.used")).toBe("Used for Secure Sign, invitations and notifications");
    expect(t("en", "pauseTitle")).toBe("Pause this mailbox completely");
  });

  it("keeps Secure Sign's name and never says Doc Sign or envelope", () => {
    for (const locale of LOCALES) {
      const block = JSON.stringify((((all[locale] as unknown as Tree).Settings as Tree).channels as Tree).mailbox);
      expect(block).not.toMatch(/Doc Sign|envelope/i);
    }
  });
});

describe("the inbox's read-only notice on an email conversation", () => {
  const composer = (locale: (typeof LOCALES)[number]) => ((all[locale] as unknown as Tree).Inbox as Tree).composer as Tree;
  it.each(LOCALES)("%s has the notices for Email and for Gmail and the placeholder", (locale) => {
    for (const key of ["emailInboxOffHint", "gmailInboxOffHint", "emailInboxOffPlaceholder"]) {
      expect(typeof composer(locale)[key], `${locale} ${key}`).toBe("string");
    }
    expect(composer("en").emailInboxOffHint).toBe("The email inbox is switched off. Turn it on in Settings > Channels > Email to reply.");
    expect(composer("en").gmailInboxOffHint).toBe("The Gmail inbox is switched off. Turn it on in Settings > Channels > Gmail to reply.");
  });

  it("is in the audit trail's field names", () => {
    for (const locale of LOCALES) expect(typeof (((all[locale] as unknown as Tree).Audit as Tree).fields as Tree).inbox_enabled).toBe("string");
  });
});
