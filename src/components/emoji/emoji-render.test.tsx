import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { sampleData } from "@/lib/emoji/test-fixtures";
import type { ChannelType } from "@/types";

// Render smoke tests for the emoji picker panel, the ":" suggestion list and the
// composer's smiley button, in English and Korean with the real catalogues.
// next-intl errors are thrown so a missing key fails here instead of showing a
// raw key path to an agent.

const state = vi.hoisted(() => ({ caps: new Set<string>() }));

vi.mock("@/hooks/use-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-auth")>();
  return {
    ...actual,
    useAuth: () => ({
      accountId: "acc-1",
      user: { id: "u-me" },
      accountRole: "agent",
      capabilities: state.caps,
      capabilitiesLoading: false,
      profileLoading: false,
      loading: false,
    }),
    useCapability: (cap: string) => state.caps.has(cap),
  };
});

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  usePathname: () => "/",
}));

import { EmojiPanel, EmojiPicker } from "./emoji-picker";
import { EmojiSuggestions } from "./emoji-suggestions";
import { EmojiTextarea } from "./emoji-textarea";
import { MessageComposer } from "@/components/inbox/message-composer";

const load = (locale: string) => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"));

function render(locale: string, node: React.ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={load(locale)}
      timeZone="UTC"
      onError={(e: Error) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const data = sampleData();
const noop = () => {};

describe.each([
  ["en", { add: "Add emoji", search: "Search emoji", none: "Smileys &amp; emotion", tone: "Skin tone" }],
  ["ko", { add: "이모지 추가", search: "이모지 검색", none: "표정 및 감정", tone: "피부톤" }],
])("emoji picker (%s)", (locale, words) => {
  it("renders the panel: search, category tabs, sections, tone selector, named buttons", () => {
    const html = render(locale, <EmojiPanel data={data} onPick={noop} />);
    expect(html).toContain(`aria-label="${words.search}"`);
    expect(html).toContain(words.none);
    expect(html).toContain(`aria-label="${words.tone}"`);
    // Every emoji button is named by its English name and shows a tooltip.
    expect(html).toContain('aria-label="grinning face"');
    expect(html).toContain('title="grinning face"');
    expect(html).toContain("😀");
    // Six tone swatches (radio buttons).
    expect(html.match(/role="radio"/g)).toHaveLength(6);
    // One tab per non-empty category, plus none for "frequently used" (nothing used yet in a fresh server render).
    expect(html.match(/aria-pressed=/g)).toHaveLength(data.groups.length);
    // Only the first category or two render straight away; the rest follow on a timer.
    expect(html).not.toContain("🇰🇷");
  });

  it("renders the trigger button with its accessible name", () => {
    const html = render(locale, <EmojiPicker onPick={noop} />);
    expect(html).toContain(`aria-label="${words.add}"`);
    expect(html).not.toMatch(DISABLED);
    expect(render(locale, <EmojiPicker onPick={noop} disabled />)).toMatch(/<button[^>]*\sdisabled(=|\s|>)/);
  });

  it("renders the suggestion list as a labelled listbox with named options", () => {
    const items = [data.byShortcode.get("smiley")!, data.byShortcode.get("grinning")!];
    const html = render(locale, <EmojiSuggestions items={items} query="smi" selectedIndex={0} tone={0} onPick={noop} />);
    expect(html).toContain('role="listbox"');
    expect(html).toContain(locale === "en" ? 'aria-label="Emoji suggestions"' : 'aria-label="이모지 추천"');
    expect(html).toContain(":smiley:");
    expect(html).toContain('aria-selected="true"');
    expect(html.match(/role="option"/g)).toHaveLength(2);
  });

  it("renders nothing for an empty suggestion list", () => {
    expect(render(locale, <EmojiSuggestions items={[]} query="zz" selectedIndex={0} tone={0} onPick={noop} />)).toBe("");
  });

  it("gives a plain textarea a smiley button", () => {
    const html = render(locale, <EmojiTextarea value="hi" onValueChange={noop} aria-label="Note" />);
    expect(html).toContain("<textarea");
    expect(html).toContain(`aria-label="${words.add}"`);
  });
});

function composer(locale: string, caps: string[], props: { sessionExpired?: boolean; channel?: ChannelType } = {}) {
  state.caps = new Set(caps);
  const channel = props.channel ?? "whatsapp";
  return render(
    locale,
    <MessageComposer
      conversationId="c1"
      channelType={channel}
      availableChannels={[channel]}
      sessionExpired={props.sessionExpired ?? false}
      onSend={noop}
      onSendMedia={noop}
      onSendInteractive={noop}
      onSendComment={noop}
      onOpenTemplates={noop}
    />,
  );
}

/** A real `disabled` attribute (not the `disabled:` Tailwind variant in the class list). */
const DISABLED = /\sdisabled(=|\s|>)/;

const emojiButton = (html: string, label: string) =>
  new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? null;

describe.each([
  ["en", "Add emoji", "Type a message... (Shift+Enter for new line, : for emoji)"],
  ["ko", "이모지 추가", "메시지를 입력하세요... (줄바꿈은 Shift+Enter, 이모지는 :)"],
])("composer emoji button (%s)", (locale, label, placeholder) => {
  it("shows an enabled smiley button next to the box for someone who can send", () => {
    const btn = emojiButton(composer(locale, ["messages.send", "conversations.manage"]), label);
    expect(btn).not.toBeNull();
    expect(btn).not.toMatch(DISABLED);
  });

  it("mentions ':' for emoji in the placeholder", () => {
    expect(composer(locale, ["messages.send"])).toContain(`placeholder="${placeholder}"`);
  });

  it("disables the button exactly when the box is disabled: read-only role", () => {
    const html = composer(locale, []);
    expect(emojiButton(html, label)).toMatch(DISABLED);
    expect(html).toMatch(/<textarea[^>]*\sdisabled(=|\s|>)/);
  });

  it("disables the button exactly when the box is disabled: expired session", () => {
    const html = composer(locale, ["messages.send"], { sessionExpired: true });
    expect(emojiButton(html, label)).toMatch(DISABLED);
    expect(html).toMatch(/<textarea[^>]*\sdisabled(=|\s|>)/);
  });
});
