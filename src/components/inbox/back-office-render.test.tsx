import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Static renders of the Vircle Back Office rail and panel in every language, with the real wording from messages/<locale>.json (next-intl is told to
// throw on a missing key):
//   the rail minimised (icon only, a tooltip and aria-label) and expanded (label and hint), its width, and the toggle's state
//   the panel's form: the phone prefilled as held, empty with the "no phone" hint, the Open in new tab link (#q=, %2B, target and rel) or its disabled twin
//   Search with embedding off (the "Opened in a new tab" line, no frame) and on (the frame: src, sandbox, no referrer, title, loading line and note)
// renderToStaticMarkup paints the FIRST render only. NOT covered (no DOM renderer, no browser): clicking the rail or the chevron, the localStorage
// read after mount, the slide-in, the dialog's focus moving into the phone box and back to the button that opened it, Tab staying inside, Esc closing,
// the sheet's width actually being 60vw / 360 px / the whole screen, the hidden frame staying loaded while minimised, window.open, the frame really loading the Back Office, and dark mode. The dialog
// shell (base-ui Dialog in a portal) draws nothing on the server, so the panel is tested through its body and the pure reducer (panel.test.ts).

import { PANEL_CLOSED, panelReducer, type PanelState } from "@/lib/back-office/panel";
import { BACK_OFFICE_RAIL_COLLAPSED_PX, BACK_OFFICE_RAIL_EXPANDED_PX } from "@/lib/back-office/rail";

import { BackOfficePanel, BackOfficePanelBody, BACK_OFFICE_FRAME_SANDBOX } from "./back-office-panel";
import { BackOfficeRail } from "./back-office-rail";

const LOCALES = ["en", "ms", "zh", "ko"] as const;
type Locale = (typeof LOCALES)[number];
type Tree = Record<string, unknown>;
const catalogue = (locale: string): Tree => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Tree;
const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [l, catalogue(l)])) as Record<Locale, Tree>;
const tr = (locale: Locale) =>
  createTranslator({ locale, messages: CATALOGUES[locale] as never, namespace: "Inbox.backOffice" as never }) as unknown as (key: string) => string;

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
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
/** The attribute value as the browser would read it. */
const attr = (html: string, name: string) => {
  const m = html.match(new RegExp(`\\s${name}="([^"]*)"`, "i"));
  return m ? m[1].replace(/&amp;/g, "&") : null;
};

const UAT = "https://v2-uat.vircle.net/app-user-details-b";
const noop = () => undefined;

// ---- the rail ---------------------------------------------------------------------------------------------------------------------

describe.each(LOCALES)("Back Office rail (%s)", (locale) => {
  const t = tr(locale);
  const rail = (expanded: boolean) => page(locale, <BackOfficeRail expanded={expanded} onToggleExpanded={noop} onOpen={noop} />);

  it("minimised: icon only, with a tooltip and an aria-label, and no visible label", () => {
    const html = rail(false);
    expect(html).toContain('data-expanded="false"');
    expect(html).toContain(`width:${BACK_OFFICE_RAIL_COLLAPSED_PX}px`);
    expect(html).toContain(`aria-label="${t("railLabel")}"`);
    expect(html).toContain(`title="${t("railLabel")}"`);
    expect(html).toContain(`aria-label="${t("expandRail")}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="dialog"');
    const visible = text(html);
    expect(visible).not.toContain(t("railHint"));
    expect(visible).not.toContain(t("railTitle"));
    expect(html).toContain("<svg");
  });

  it("expanded: the label and its sub line beside the icon, and the toggle offers to hide the labels", () => {
    const html = rail(true);
    expect(html).toContain('data-expanded="true"');
    expect(html).toContain(`width:${BACK_OFFICE_RAIL_EXPANDED_PX}px`);
    expect(text(html)).toContain(t("railTitle"));
    expect(text(html)).toContain(t("railHint"));
    expect(html).toContain(`aria-label="${t("collapseRail")}"`);
    expect(html).toContain('aria-expanded="true"');
  });

  it("is a labelled region of real buttons: keyboard reachable, a visible focus ring, hidden below xl, no link to anywhere", () => {
    for (const expanded of [false, true]) {
      const html = rail(expanded);
      expect(html).toContain(`aria-label="${t("railRegion")}"`);
      expect(html).toMatch(/<aside[^>]*class="[^"]*\bhidden\b[^"]*\bxl:flex\b/);
      expect(html.match(/<button /g)).toHaveLength(2);
      expect(html.match(/focus-visible:ring-2/g)!.length).toBeGreaterThanOrEqual(2);
      expect(html).not.toContain("tabindex");
      // the rail itself never carries a phone number or an address: it only opens the panel
      expect(html).not.toContain("href=");
      expect(html).not.toContain("#q=");
    }
  });

  it("uses tokens for colour, never a Tailwind dark: variant", () => {
    const html = rail(true);
    expect(html).toContain("bg-card");
    expect(html).toContain("border-border");
    expect(html).not.toMatch(/\bdark:/);
  });
});

// ---- the panel --------------------------------------------------------------------------------------------------------------------

const opened = (contactPhone: string | null) => panelReducer(PANEL_CLOSED, { type: "open", contactPhone });
const searched = (contactPhone: string, extra: Parameters<typeof panelReducer>[1][] = []) =>
  [{ type: "search" } as const, ...extra].reduce(panelReducer, opened(contactPhone));

function body(locale: Locale, state: PanelState, opts: { embed?: boolean; contactHasPhone?: boolean } = {}) {
  return page(
    locale,
    <BackOfficePanelBody
      state={state}
      baseUrl={UAT}
      embed={opts.embed ?? false}
      contactHasPhone={opts.contactHasPhone ?? state.phone.trim() !== ""}
      onEdit={noop}
      onSearch={noop}
      onReset={noop}
      onClose={noop}
      onMinimize={noop}
      onToggleMaximize={noop}
      onFrameLoaded={noop}
      titleId="bo-title"
    />,
  );
}

describe.each(LOCALES)("Back Office panel (%s)", (locale) => {
  const t = tr(locale);

  it("shows the header, the form, and the phone prefilled exactly as held", () => {
    const html = body(locale, opened("+60123456789"));
    const visible = text(html);
    expect(visible).toContain(t("panelTitle"));
    expect(visible).toContain(t("panelSubtitle"));
    expect(visible).toContain(t("findTitle"));
    expect(visible).toContain(t("search"));
    expect(html).toContain('id="bo-title"');
    expect(html).toContain(`aria-label="${t("close")}"`);
    expect(html).toContain(`placeholder="${t("phonePlaceholder")}"`);
    expect(html).toContain('value="+60123456789"');
    expect(html).toContain('type="tel"');
    expect(html).not.toContain("<iframe");
    expect(visible).not.toContain(t("noPhone"));
    expect(visible).not.toContain(t("findAnother"));
    expect(html).not.toContain("disabled=");
  });

  it("does not normalise a prefilled number with a leading zero", () => {
    expect(body(locale, opened("0123456789"))).toContain('value="0123456789"');
  });

  it("offers Open in new tab as a real link with the #q= address, %2B for a plus, and no opener or referrer", () => {
    const html = body(locale, opened("+60123456789"));
    const a = html.match(/<a [^>]*>/)![0];
    expect(attr(a, "href")).toBe(`${UAT}#q=%2B60123456789`);
    expect(attr(a, "target")).toBe("_blank");
    expect(attr(a, "rel")).toBe("noopener noreferrer");
    expect(text(html)).toContain(t("openInNewTab"));
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("with no phone on the contact: an empty box, the hint, a disabled Search and a disabled-looking Open in new tab with no href", () => {
    const html = body(locale, opened(null), { contactHasPhone: false });
    expect(html).toContain('value=""');
    expect(text(html)).toContain(t("noPhone"));
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("#q=");
  });

  it("a number typed into an empty box enables Search and the link", () => {
    const html = body(locale, panelReducer(opened(null), { type: "edit", phone: "0123456789" }), { contactHasPhone: false });
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(attr(html.match(/<a [^>]*>/)![0], "href")).toBe(`${UAT}#q=0123456789`);
    // typing a number does not hide it again: the hint goes once there is something in the box
    expect(text(html)).not.toContain(t("noPhone"));
  });

  it("embedding OFF, after Search: the calm 'opened in a new tab' line, Find another user, the link, and no frame", () => {
    const html = body(locale, searched("+60123456789"), { embed: false });
    const visible = text(html);
    expect(visible).toContain(t("openedInTab"));
    expect(visible).toContain(t("findAnother"));
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<iframe");
    expect(attr(html.match(/<a [^>]*>/)![0], "href")).toBe(`${UAT}#q=%2B60123456789`);
  });

  it("embedding ON, before any Search: the form only, no frame", () => {
    const html = body(locale, opened("+60123456789"), { embed: true });
    expect(html).not.toContain("<iframe");
    expect(text(html)).not.toContain(t("frameNote"));
  });

  it("embedding ON, after Search: a sandboxed frame without a referrer, titled, with a loading line and the note", () => {
    const html = body(locale, searched("+60123456789"), { embed: true });
    const frame = html.match(/<iframe[^>]*>/)![0];
    // the frame is told it is inside Halo (&embed=1); the phone is read exactly as before
    expect(attr(frame, "src")).toBe(`${UAT}#q=%2B60123456789&embed=1`);
    expect(attr(frame, "sandbox")).toBe("allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox");
    expect(attr(frame, "sandbox")).toBe(BACK_OFFICE_FRAME_SANDBOX);
    expect(attr(frame, "referrerPolicy")).toBe("no-referrer");
    expect(attr(frame, "title")).toBe(t("frameTitle"));
    const visible = text(html);
    expect(visible).toContain(t("frameLoading"));
    expect(visible).toContain(t("frameNote"));
    expect(visible).toContain(t("findAnother"));
    expect(visible).not.toContain(t("openedInTab"));
    // the new-tab link stays available beside the frame
    expect(html).toContain('target="_blank"');
  });

  it("embedding ON: the loading line goes once the frame has loaded", () => {
    const html = body(locale, searched("+60123456789", [{ type: "frame-loaded" }]), { embed: true });
    expect(html).toContain("<iframe");
    expect(text(html)).not.toContain(t("frameLoading"));
  });

  it("embedding ON: the frame shows what was searched, not what is being typed next", () => {
    const state = panelReducer(searched("0123456789"), { type: "edit", phone: "0999" });
    const html = body(locale, state, { embed: true });
    expect(attr(html.match(/<iframe[^>]*>/)![0], "src")).toBe(`${UAT}#q=0123456789&embed=1`);
    expect(attr(html.match(/<a [^>]*>/)![0], "href")).toBe(`${UAT}#q=0999`);
  });

  it("never renders a frame once the person has gone back to the form (Find another user)", () => {
    const state = panelReducer(searched("0123456789"), { type: "reset" });
    expect(body(locale, state, { embed: true })).not.toContain("<iframe");
  });

  it("uses tokens for colour, never a Tailwind dark: variant", () => {
    const html = body(locale, searched("0123456789"), { embed: true });
    expect(html).toContain("bg-background");
    expect(html).toContain("border-border");
    expect(html).not.toMatch(/\bdark:/);
  });
});

describe.each(LOCALES)("Back Office panel: minimise, maximise, close (%s)", (locale) => {
  const t = tr(locale);
  const labelled = (html: string, action: string) => html.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))?.[0] ?? "";

  it("has three separate buttons in the header, each named in words", () => {
    const html = body(locale, opened("0123"));
    for (const [action, key] of [["minimise", "minimise"], ["maximise", "maximise"], ["close", "close"]] as const) {
      const b = labelled(html, action);
      expect(b, action).not.toBe("");
      expect(attr(b, "aria-label"), action).toBe(t(key));
      expect(attr(b, "title"), action).toBe(t(key));
    }
    // three different words, so no button can be mistaken for another
    expect(new Set([t("minimise"), t("maximise"), t("close")]).size).toBe(3);
  });

  it("the size button says what it will do: full screen, then back to the usual size", () => {
    const usual = labelled(body(locale, opened("0123")), "maximise");
    expect(attr(usual, "aria-label")).toBe(t("maximise"));
    expect(usual).toContain('aria-pressed="false"');
    const big = labelled(body(locale, panelReducer(opened("0123"), { type: "toggle-maximize" })), "maximise");
    expect(attr(big, "aria-label")).toBe(t("restoreSize"));
    expect(big).toContain('aria-pressed="true"');
    expect(t("restoreSize")).not.toBe(t("maximise"));
  });

  it("the size button is for screens wider than a phone, where the panel is already the whole width", () => {
    expect(labelled(body(locale, opened("0123")), "maximise")).toContain("hidden");
    expect(labelled(body(locale, opened("0123")), "maximise")).toContain("sm:inline-flex");
  });

  it("the rail button says a panel is put away, in words and a dot, and a plain one does not", () => {
    const plain = page(locale, <BackOfficeRail expanded={false} onToggleExpanded={noop} onOpen={noop} />);
    const away = page(locale, <BackOfficeRail expanded={false} onToggleExpanded={noop} onOpen={noop} minimized />);
    expect(plain).not.toContain("back-office-minimised-dot");
    expect(away).toContain("back-office-minimised-dot");
    const button = (html: string) => html.match(/<button[^>]*aria-haspopup="dialog"[^>]*>/)![0];
    expect(attr(button(plain), "aria-label")).toBe(t("railLabel"));
    expect(attr(button(away), "aria-label")).toBe(t("railLabelMinimised"));
    expect(attr(button(away), "title")).toBe(t("railLabelMinimised"));
    expect(button(away)).toContain('data-minimized="true"');
    expect(t("railLabelMinimised")).not.toBe(t("railLabel"));
  });
});

describe("Back Office panel shell", () => {
  it("draws nothing at all while closed, so no frame can load in the background", () => {
    const html = page("en", <BackOfficePanel state={PANEL_CLOSED} dispatch={noop} baseUrl={UAT} embed contactPhone="0123" />);
    expect(html).toBe("");
  });
});
