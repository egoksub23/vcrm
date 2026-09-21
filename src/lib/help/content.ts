import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter";
import { renderMarkdown, type RenderOptions } from "./markdown";
import { sortSections } from "./nav";
import type {
  HelpContent,
  HelpPage,
  HelpSearchDoc,
  HelpSection,
  HelpSectionMeta,
} from "./types";

// Server-only: reads content/help/** from disk. Nothing here throws for bad
// content: a broken page or section file is skipped (or given fallbacks) and a
// warning is recorded and logged, so one typo never takes the whole guide down.
// content.test.ts turns those warnings into test failures for the real content.

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function helpContentRoot(): string {
  return path.join(process.cwd(), "content", "help");
}

export function helpImageDir(): string {
  return path.join(process.cwd(), "public", "help", "img");
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function readSectionMeta(dir: string, slug: string, warnings: string[]): HelpSectionMeta {
  const fallback: HelpSectionMeta = { title: titleFromSlug(slug), order: 999, description: "" };
  const file = path.join(dir, "_section.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    warnings.push(`${slug}/_section.json is missing; using defaults`);
    return fallback;
  }
  try {
    const json = JSON.parse(raw.replace(/^﻿/, "")) as Partial<HelpSectionMeta>;
    const title = typeof json.title === "string" && json.title.trim() ? json.title.trim() : "";
    const order = typeof json.order === "number" && Number.isFinite(json.order) ? json.order : NaN;
    const description = typeof json.description === "string" ? json.description.trim() : "";
    if (!title) warnings.push(`${slug}/_section.json has no title; using "${fallback.title}"`);
    if (Number.isNaN(order)) warnings.push(`${slug}/_section.json has no numeric order`);
    if (!description) warnings.push(`${slug}/_section.json has no description`);
    return {
      title: title || fallback.title,
      order: Number.isNaN(order) ? fallback.order : order,
      description,
    };
  } catch (err) {
    warnings.push(`${slug}/_section.json is not valid JSON (${(err as Error).message}); using defaults`);
    return fallback;
  }
}

/** Read a content folder. Pure apart from the file reads. */
export function loadHelpContentFrom(root: string): HelpContent {
  const warnings: string[] = [];
  const sections: HelpSection[] = [];

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    warnings.push(`content folder not found: ${root}`);
    return { sections, warnings };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const slug = entry.name;
    if (!SLUG_PATTERN.test(slug)) {
      warnings.push(`section folder "${slug}" skipped: use lower-case letters, digits and hyphens`);
      continue;
    }
    const dir = path.join(root, slug);
    const meta = readSectionMeta(dir, slug, warnings);
    const pages: HelpPage[] = [];

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".md") || file.startsWith("_") || file.startsWith(".")) continue;
      const pageSlug = file.slice(0, -3);
      const label = `${slug}/${file}`;
      if (!SLUG_PATTERN.test(pageSlug)) {
        warnings.push(`${label} skipped: use lower-case letters, digits and hyphens in the file name`);
        continue;
      }
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(dir, file), "utf8");
      } catch (err) {
        warnings.push(`${label} skipped: cannot be read (${(err as Error).message})`);
        continue;
      }
      const parsed = parseFrontmatter(raw);
      if (!parsed.ok) {
        warnings.push(`${label} skipped: ${parsed.error}`);
        continue;
      }
      pages.push({
        ...parsed.value.meta,
        section: slug,
        slug: pageSlug,
        href: `/help/${slug}/${pageSlug}`,
        body: parsed.value.body,
      });
    }

    if (pages.length === 0) {
      warnings.push(`section "${slug}" has no valid pages and is hidden`);
      continue;
    }
    sections.push({ ...meta, slug, href: `/help/${slug}`, pages });
  }

  return { sections: sortSections(sections), warnings };
}

const cache = new Map<string, HelpContent>();

/**
 * The guide's content. In production it is read once per process (the files
 * are part of the release); in development it is re-read on every call so a
 * saved edit shows up on refresh.
 */
export function getHelpContent(root = helpContentRoot()): HelpContent {
  const cacheable = process.env.NODE_ENV === "production";
  const hit = cacheable ? cache.get(root) : undefined;
  if (hit) return hit;
  const content = loadHelpContentFrom(root);
  for (const w of content.warnings) console.warn(`[help] ${w}`);
  if (cacheable) cache.set(root, content);
  return content;
}

/** Existence check for /help/img/... screenshots (used for the placeholder). */
export function localImageExists(src: string, imageDir = helpImageDir()): boolean | undefined {
  const m = /^\/help\/img\/([^/?#]+)$/.exec(src.trim());
  if (!m) return undefined;
  return fs.existsSync(path.join(imageDir, decodeURIComponent(m[1])));
}

/** Render options wired to the real disk, for the page components. */
export function diskRenderOptions(): Pick<RenderOptions, "imageExists" | "showMissingFileName"> {
  return {
    imageExists: (src) => localImageExists(src),
    showMissingFileName: process.env.NODE_ENV !== "production",
  };
}

/** Documents for the search box: title, section, description, headings and plain body text. */
export function buildSearchDocs(content: HelpContent): HelpSearchDoc[] {
  return content.sections.flatMap((section) =>
    section.pages.map((page) => {
      const rendered = renderMarkdown(page.body);
      return {
        id: page.href,
        title: page.title,
        section: section.title,
        description: page.description,
        headings: rendered.headings.map((h) => h.text).join("\n"),
        body: rendered.text,
      };
    }),
  );
}

let searchDocsCache: { content: HelpContent; docs: HelpSearchDoc[] } | null = null;

export function getSearchDocs(): HelpSearchDoc[] {
  const content = getHelpContent();
  // getHelpContent returns the same object in production, so this memoises there.
  if (searchDocsCache && searchDocsCache.content === content) return searchDocsCache.docs;
  const docs = buildSearchDocs(content);
  searchDocsCache = { content, docs };
  return docs;
}
