import type { HelpContent, HelpNavSection, HelpPage, HelpSection } from "./types";

// Pure helpers over loaded content (no fs): safe for server and client.

export const HELP_ROOT = "/help";

/** Sections sorted by order then slug; pages by order then title. */
export function sortSections(sections: HelpSection[]): HelpSection[] {
  return sections
    .map((s) => ({
      ...s,
      pages: [...s.pages].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
    }))
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

/** The lean tree the client renders. Bodies are left out on purpose. */
export function buildNav(content: HelpContent): HelpNavSection[] {
  return content.sections.map((s) => ({
    slug: s.slug,
    title: s.title,
    href: s.href,
    description: s.description,
    pages: s.pages.map((p) => ({ slug: p.slug, title: p.title, href: p.href })),
  }));
}

/** Every page in reading order (section order, then page order). */
export function flattenPages(content: HelpContent): HelpPage[] {
  return content.sections.flatMap((s) => s.pages);
}

export function findSection(content: HelpContent, sectionSlug: string): HelpSection | undefined {
  return content.sections.find((s) => s.slug === sectionSlug);
}

export function findPage(
  content: HelpContent,
  sectionSlug: string,
  pageSlug: string,
): HelpPage | undefined {
  return findSection(content, sectionSlug)?.pages.find((p) => p.slug === pageSlug);
}

export interface PrevNext {
  prev: HelpPage | null;
  next: HelpPage | null;
}

/** Previous and next page in reading order, crossing section boundaries. */
export function prevNext(content: HelpContent, page: Pick<HelpPage, "href">): PrevNext {
  const all = flattenPages(content);
  const i = all.findIndex((p) => p.href === page.href);
  if (i === -1) return { prev: null, next: null };
  return { prev: all[i - 1] ?? null, next: all[i + 1] ?? null };
}

/** "Start here": the first pages of the first section. */
export function startHerePages(content: HelpContent, limit = 4): HelpPage[] {
  return content.sections[0]?.pages.slice(0, limit) ?? [];
}

/** The URL path -> the section slug and page slug it points at (either may be missing). */
export function parseHelpPath(pathname: string): { section?: string; page?: string } {
  const clean = pathname.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  if (clean !== HELP_ROOT && !clean.startsWith(`${HELP_ROOT}/`)) return {};
  const [section, page] = clean.slice(HELP_ROOT.length).split("/").filter(Boolean);
  return { section, page };
}

/** True when `href` is a link to a page or section of the guide (not an image or asset). */
export function isHelpLink(href: string): boolean {
  if (href.startsWith(`${HELP_ROOT}/img/`)) return false;
  return href === HELP_ROOT || href.startsWith(`${HELP_ROOT}/`) || href.startsWith(`${HELP_ROOT}#`);
}
