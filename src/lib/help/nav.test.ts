import { describe, expect, it } from "vitest";
import {
  buildNav,
  findPage,
  findSection,
  flattenPages,
  isHelpLink,
  parseHelpPath,
  prevNext,
  sortSections,
  startHerePages,
} from "./nav";
import type { HelpContent, HelpPage, HelpSection } from "./types";

function page(section: string, slug: string, order: number, title = slug): HelpPage {
  return {
    section,
    slug,
    order,
    title,
    description: `${title} description`,
    href: `/help/${section}/${slug}`,
    body: "secret body",
  };
}

function section(slug: string, order: number, pages: HelpPage[]): HelpSection {
  return { slug, order, title: slug.toUpperCase(), description: "", href: `/help/${slug}`, pages };
}

// Deliberately unsorted input.
const raw: HelpSection[] = [
  section("b", 2, [page("b", "b2", 2), page("b", "b1", 1)]),
  section("a", 1, [page("a", "a2", 2), page("a", "a1", 1), page("a", "a1b", 1, "Zebra")]),
  section("c", 2, [page("c", "c1", 1)]),
];
const content: HelpContent = { sections: sortSections(raw), warnings: [] };

describe("sortSections", () => {
  it("orders sections by order then slug, and pages by order then title", () => {
    expect(content.sections.map((s) => s.slug)).toEqual(["a", "b", "c"]);
    expect(content.sections[0].pages.map((p) => p.slug)).toEqual(["a1", "a1b", "a2"]);
    expect(content.sections[1].pages.map((p) => p.slug)).toEqual(["b1", "b2"]);
  });

  it("does not mutate its input", () => {
    expect(raw[0].slug).toBe("b");
    expect(raw[0].pages[0].slug).toBe("b2");
  });
});

describe("buildNav", () => {
  it("keeps titles and links but never the page bodies", () => {
    const nav = buildNav(content);
    expect(nav[0]).toEqual({
      slug: "a",
      title: "A",
      href: "/help/a",
      description: "",
      pages: [
        { slug: "a1", title: "a1", href: "/help/a/a1" },
        { slug: "a1b", title: "Zebra", href: "/help/a/a1b" },
        { slug: "a2", title: "a2", href: "/help/a/a2" },
      ],
    });
    expect(JSON.stringify(nav)).not.toContain("secret body");
  });
});

describe("lookup and reading order", () => {
  it("flattens in reading order", () => {
    expect(flattenPages(content).map((p) => p.href)).toEqual([
      "/help/a/a1",
      "/help/a/a1b",
      "/help/a/a2",
      "/help/b/b1",
      "/help/b/b2",
      "/help/c/c1",
    ]);
  });

  it("finds sections and pages", () => {
    expect(findSection(content, "b")?.slug).toBe("b");
    expect(findSection(content, "zzz")).toBeUndefined();
    expect(findPage(content, "b", "b2")?.href).toBe("/help/b/b2");
    expect(findPage(content, "b", "a1")).toBeUndefined();
  });

  it("gives previous and next, crossing section boundaries", () => {
    const a2 = findPage(content, "a", "a2")!;
    expect(prevNext(content, a2)).toMatchObject({
      prev: { slug: "a1b" },
      next: { slug: "b1", section: "b" },
    });
  });

  it("has no previous on the first page and no next on the last", () => {
    expect(prevNext(content, flattenPages(content)[0]).prev).toBeNull();
    const last = flattenPages(content).at(-1)!;
    expect(prevNext(content, last).next).toBeNull();
    expect(prevNext(content, last).prev?.slug).toBe("b2");
  });

  it("returns nothing for an unknown page", () => {
    expect(prevNext(content, { href: "/help/x/y" })).toEqual({ prev: null, next: null });
  });

  it("picks the first pages of the first section for Start here", () => {
    expect(startHerePages(content, 2).map((p) => p.slug)).toEqual(["a1", "a1b"]);
    expect(startHerePages({ sections: [], warnings: [] })).toEqual([]);
  });
});

describe("parseHelpPath / isHelpLink", () => {
  it("splits a URL path", () => {
    expect(parseHelpPath("/help")).toEqual({ section: undefined, page: undefined });
    expect(parseHelpPath("/help/inbox")).toEqual({ section: "inbox", page: undefined });
    expect(parseHelpPath("/help/inbox/reply/?x=1#top")).toEqual({ section: "inbox", page: "reply" });
    expect(parseHelpPath("/inbox")).toEqual({});
    expect(parseHelpPath("/helpful")).toEqual({});
  });

  it("recognises guide links", () => {
    expect(isHelpLink("/help")).toBe(true);
    expect(isHelpLink("/help/inbox/x#y")).toBe(true);
    expect(isHelpLink("/help/img/a.png")).toBe(false);
    expect(isHelpLink("/helpful")).toBe(false);
    expect(isHelpLink("https://example.com/help/x")).toBe(false);
  });
});
