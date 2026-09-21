import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";

let mockPath = "/help/inbox/reply-to-customers";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { HelpTree } from "./help-tree";
import { HelpOutline } from "./help-outline";
import { HelpSearchPanel } from "./help-search";
import type { HelpNavSection } from "@/lib/help/types";

// Server-render smoke tests (the repo has no DOM test library): the tree marks
// the current page and only opens the current section; the chrome renders.
const messages = JSON.parse(fs.readFileSync(path.join(process.cwd(), "messages", "en.json"), "utf8"));
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
      {node}
    </NextIntlClientProvider>,
  );

const nav: HelpNavSection[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    href: "/help/getting-started",
    description: "",
    pages: [{ slug: "welcome", title: "Welcome", href: "/help/getting-started/welcome" }],
  },
  {
    slug: "inbox",
    title: "Inbox",
    href: "/help/inbox",
    description: "",
    pages: [
      { slug: "inbox-overview", title: "Inbox overview", href: "/help/inbox/inbox-overview" },
      { slug: "reply-to-customers", title: "Reply to customers", href: "/help/inbox/reply-to-customers" },
    ],
  },
];

describe("HelpTree", () => {
  it("opens the current section, marks the current page and leaves other sections collapsed", () => {
    mockPath = "/help/inbox/reply-to-customers";
    const html = render(<HelpTree nav={nav} />);
    expect(html).toContain("Reply to customers");
    expect(html).toContain('aria-current="page"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain("Inbox overview");
    // Getting started is collapsed: its page is not rendered.
    expect(html).not.toContain(">Welcome<");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-expanded="true"');
  });

  it("highlights the guide home on /help", () => {
    mockPath = "/help";
    const html = render(<HelpTree nav={nav} />);
    expect(html).toMatch(/<a aria-current="page"[^>]*href="\/help"/);
    expect(html).not.toContain("Reply to customers");
  });
});

describe("HelpOutline", () => {
  it("lists the headings, indenting h3", () => {
    const html = render(
      <HelpOutline
        headings={[
          { id: "a", text: "Send", depth: 2 },
          { id: "b", text: "Details", depth: 3 },
        ]}
      />,
    );
    expect(html).toContain("On this page");
    expect(html).toContain('href="#a"');
    expect(html).toContain("pl-6");
  });

  it("renders nothing for fewer than two headings", () => {
    expect(render(<HelpOutline headings={[{ id: "a", text: "Only", depth: 2 }]} />)).toBe("");
  });
});

describe("HelpSearchPanel", () => {
  it("renders the search box with a hint before anything is typed", () => {
    const html = render(<HelpSearchPanel />);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('placeholder="Search the guide"');
    expect(html).toContain("Type to search");
  });
});
