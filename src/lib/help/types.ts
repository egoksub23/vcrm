// Shared types for the in-CRM User Guide (/help). Pure types: safe to import
// from server and client code.

/** Frontmatter of one page (content/help/<section>/<page>.md). */
export interface HelpFrontmatter {
  title: string;
  description: string;
  order: number;
  /** ISO date (YYYY-MM-DD), optional. */
  updated?: string;
}

/** Contents of content/help/<section>/_section.json. */
export interface HelpSectionMeta {
  title: string;
  order: number;
  description: string;
}

export interface HelpPage extends HelpFrontmatter {
  /** Section folder name, e.g. "inbox". */
  section: string;
  /** File name without ".md", e.g. "reply-to-customers". */
  slug: string;
  /** "/help/<section>/<slug>". */
  href: string;
  /** Markdown body (frontmatter removed). Server only: never send to the client. */
  body: string;
}

export interface HelpSection extends HelpSectionMeta {
  slug: string;
  href: string;
  pages: HelpPage[];
}

export interface HelpContent {
  sections: HelpSection[];
  /** Problems found while loading (bad files are skipped, never thrown). */
  warnings: string[];
}

/** What the client needs to draw the left-hand tree. */
export interface HelpNavPage {
  slug: string;
  title: string;
  href: string;
}

export interface HelpNavSection {
  slug: string;
  title: string;
  href: string;
  description: string;
  pages: HelpNavPage[];
}

export interface HelpHeading {
  id: string;
  text: string;
  depth: 2 | 3;
}

/** One document of the search index (built on the server, shipped as JSON). */
export interface HelpSearchDoc {
  /** The page URL; doubles as the unique id. */
  id: string;
  title: string;
  section: string;
  description: string;
  /** Heading texts joined with a newline. */
  headings: string;
  /** Plain text of the body. */
  body: string;
}
