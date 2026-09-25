import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadHelpContentFrom, SLUG_PATTERN } from "./content";
import { renderMarkdown } from "./markdown";
import { flattenPages, isHelpLink } from "./nav";

// Guards the real guide (content/help/**) the way a typecheck guards code:
// a broken page, link or screenshot reference fails CI instead of shipping.
// The loader itself never throws (a bad file is skipped), so this is where
// mistakes become visible.

const ROOT = process.cwd();
const CONTENT = path.join(ROOT, "content", "help");
const IMG_DIR = path.join(ROOT, "public", "help", "img");

// The fixed contract between the writers and the guide (section -> pages).
const EXPECTED: Record<string, string[]> = {
  "getting-started": ["welcome", "screen-tour", "roles-and-permissions", "keyboard-shortcuts"],
  inbox: [
    "inbox-overview",
    "reply-to-customers",
    "assign-and-transfer",
    "close-and-reopen",
    "notes-and-mentions",
    "tags-labels-priority",
    "views-and-bulk-actions",
    "ai-assistance",
    "web-chat-conversations",
    "social-comments",
  ],
  contacts: ["contacts-overview", "merge-duplicates", "import-and-export", "pipelines-and-deals"],
  knowledge: ["knowledge-overview", "use-articles-in-chat", "write-and-edit-articles", "translations"],
  tickets: ["tickets-overview", "create-a-ticket", "work-a-ticket", "jira-link"],
  sembang: [
    "sembang-overview",
    "messaging-and-threads",
    "direct-messages",
    "tasks-and-meetings",
    "search-notifications-and-access",
  ],
  "working-together": ["notifications", "approvals", "broadcasts", "reports"],
  help: ["troubleshooting", "whats-new"],
};

interface ShotEntry {
  file: string;
  page: string;
  route: string;
  capture: string;
}

const content = loadHelpContentFrom(CONTENT);
const pages = flattenPages(content);
const rendered = new Map(pages.map((p) => [p.href, renderMarkdown(p.body)]));
const hrefs = new Set<string>(["/help", ...content.sections.map((s) => s.href), ...pages.map((p) => p.href)]);

function readShotLists(): { entries: (ShotEntry & { list: string })[]; errors: string[] } {
  const entries: (ShotEntry & { list: string })[] = [];
  const errors: string[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(CONTENT).filter((f) => /^_shotlist-.+\.json$/.test(f));
  } catch {
    return { entries, errors };
  }
  for (const f of files) {
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(path.join(CONTENT, f), "utf8").replace(/^﻿/, ""));
    } catch (err) {
      errors.push(`${f} is not valid JSON: ${(err as Error).message}`);
      continue;
    }
    if (!Array.isArray(json)) {
      errors.push(`${f} must be a JSON array`);
      continue;
    }
    json.forEach((raw, i) => {
      const e = raw as Partial<ShotEntry>;
      for (const key of ["file", "page", "route", "capture"] as const) {
        if (typeof e?.[key] !== "string" || !e[key]!.trim()) {
          errors.push(`${f} entry ${i + 1} is missing "${key}"`);
        }
      }
      if (typeof e?.file === "string" && typeof e.page === "string") {
        entries.push({ ...(e as ShotEntry), list: f });
      }
    });
  }
  return { entries, errors };
}

const shots = readShotLists();
const listedFiles = new Set(shots.entries.map((e) => e.file));

describe("help content: loading", () => {
  it("has a content folder", () => {
    expect(fs.existsSync(CONTENT)).toBe(true);
  });

  it("loads without warnings (bad frontmatter, missing or broken _section.json, bad names)", () => {
    expect(content.warnings).toEqual([]);
  });

  it("has valid slugs everywhere", () => {
    for (const s of content.sections) {
      expect(s.slug, s.slug).toMatch(SLUG_PATTERN);
      for (const p of s.pages) expect(p.slug, `${s.slug}/${p.slug}`).toMatch(SLUG_PATTERN);
    }
  });

  it("has no duplicate section or page slugs, and no duplicate orders within a section", () => {
    const sectionSlugs = content.sections.map((s) => s.slug.toLowerCase());
    expect(new Set(sectionSlugs).size, "duplicate section slugs").toBe(sectionSlugs.length);
    const sectionOrders = content.sections.map((s) => s.order);
    expect(new Set(sectionOrders).size, `duplicate section orders: ${sectionOrders.join(",")}`).toBe(
      sectionOrders.length,
    );
    for (const s of content.sections) {
      const slugs = s.pages.map((p) => p.slug.toLowerCase());
      expect(new Set(slugs).size, `duplicate page slugs in ${s.slug}`).toBe(slugs.length);
      const orders = s.pages.map((p) => p.order);
      expect(new Set(orders).size, `duplicate page orders in ${s.slug}: ${orders.join(",")}`).toBe(orders.length);
    }
  });

  it("has every page in the agreed section and page list", () => {
    for (const [section, expectedPages] of Object.entries(EXPECTED)) {
      const found = content.sections.find((s) => s.slug === section);
      expect(found, `missing section ${section}`).toBeDefined();
      const slugs = new Set(found?.pages.map((p) => p.slug));
      for (const page of expectedPages) expect(slugs.has(page), `missing page ${section}/${page}`).toBe(true);
    }
  });

  it("gives every page a body", () => {
    for (const p of pages) expect(p.body.trim().length, p.href).toBeGreaterThan(50);
  });
});

describe("help content: markdown", () => {
  it("renders every page without warnings (unsafe HTML, bad links, unknown callouts)", () => {
    for (const p of pages) expect(rendered.get(p.href)!.warnings, p.href).toEqual([]);
  });

  it("only links to pages, sections and headings that exist", () => {
    const headingsOf = (href: string): Set<string> => new Set(rendered.get(href)?.headings.map((h) => h.id));
    const broken: string[] = [];
    for (const p of pages) {
      for (const link of rendered.get(p.href)!.links) {
        if (link.startsWith("#")) {
          if (!headingsOf(p.href).has(link.slice(1))) broken.push(`${p.href} -> ${link} (no such heading)`);
          continue;
        }
        if (!isHelpLink(link)) continue;
        const [target, hash] = link.split("#");
        const clean = target.replace(/\/+$/, "") || "/help";
        if (!hrefs.has(clean)) {
          broken.push(`${p.href} -> ${link} (no such page)`);
        } else if (hash && !headingsOf(clean).has(hash)) {
          broken.push(`${p.href} -> ${link} (no such heading)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("gives every image alt text and a clean name under /help/img", () => {
    const bad: string[] = [];
    for (const p of pages) {
      const bodyImages = [...p.body.matchAll(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)];
      for (const m of bodyImages) {
        if (!m[1].trim()) bad.push(`${p.href}: image without alt text (${m[2]})`);
        if (!/^\/help\/img\/[a-z0-9][a-z0-9-]*\.png$/.test(m[2])) {
          bad.push(`${p.href}: image path must be /help/img/<kebab-case>.png, got ${m[2]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("help content: screenshots", () => {
  it("has valid shot lists", () => {
    expect(shots.errors).toEqual([]);
  });

  it("lists every screenshot that is not yet in public/help/img", () => {
    const missing: string[] = [];
    for (const p of pages) {
      for (const src of rendered.get(p.href)!.images) {
        const m = /^\/help\/img\/([^/?#]+)$/.exec(src);
        if (!m) continue;
        const onDisk = fs.existsSync(path.join(IMG_DIR, m[1]));
        if (!onDisk && !listedFiles.has(m[1])) missing.push(`${p.href}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("points every shot list entry at a real page that uses the image", () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const e of shots.entries) {
      if (seen.has(e.file)) problems.push(`${e.list}: ${e.file} is listed twice`);
      seen.add(e.file);
      const page = pages.find((p) => `${p.section}/${p.slug}` === e.page);
      if (!page) {
        problems.push(`${e.list}: ${e.file} points at unknown page ${e.page}`);
        continue;
      }
      if (!rendered.get(page.href)!.images.includes(`/help/img/${e.file}`)) {
        problems.push(`${e.list}: ${e.page} does not use ${e.file}`);
      }
      if (!e.route.startsWith("/")) problems.push(`${e.list}: ${e.file} route must start with /`);
    }
    expect(problems).toEqual([]);
  });
});
