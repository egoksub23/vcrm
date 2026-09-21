import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSearchDocs, loadHelpContentFrom, localImageExists } from "./content";

const FIXTURES = path.join(__dirname, "__fixtures__");

describe("loadHelpContentFrom (good fixtures)", () => {
  const content = loadHelpContentFrom(path.join(FIXTURES, "good"));

  it("loads sections and pages in order with no warnings", () => {
    expect(content.warnings).toEqual([]);
    expect(content.sections.map((s) => s.slug)).toEqual(["getting-started", "inbox"]);
    expect(content.sections[0].pages.map((p) => p.slug)).toEqual(["welcome", "screen-tour"]);
  });

  it("fills in URLs, frontmatter and the body", () => {
    const welcome = content.sections[0].pages[0];
    expect(welcome.href).toBe("/help/getting-started/welcome");
    expect(welcome.title).toBe("Welcome");
    expect(welcome.updated).toBe("2026-09-21");
    expect(welcome.body).toContain("## Sign in");
    expect(welcome.body).not.toContain("title:");
  });

  it("accepts quoted values and a colon inside a description", () => {
    const tour = content.sections[0].pages[1];
    expect(tour.title).toBe("Screen tour");
    expect(tour.description).toBe("A quick look at every menu item: what each one does.");
    expect(tour.updated).toBeUndefined();
  });

  it("builds search documents with headings and plain text", () => {
    const docs = buildSearchDocs(content);
    expect(docs).toHaveLength(3);
    const welcome = docs.find((d) => d.id === "/help/getting-started/welcome")!;
    expect(welcome.section).toBe("Getting started");
    expect(welcome.headings).toBe("Sign in");
    expect(welcome.body).toContain("Enter your email.");
    expect(welcome.body).not.toContain("[!TIP]");
  });
});

describe("loadHelpContentFrom (bad fixtures)", () => {
  const content = loadHelpContentFrom(path.join(FIXTURES, "bad"));
  const warnings = content.warnings.join("\n");

  it("never throws and keeps the good pages", () => {
    expect(content.sections.map((s) => s.slug)).toEqual(["alpha", "beta", "gamma"]);
    const alpha = content.sections.find((s) => s.slug === "alpha")!;
    expect(alpha.pages.map((p) => p.slug)).toEqual(["ok"]);
  });

  it("warns about a page without frontmatter or with a bad order", () => {
    expect(warnings).toContain("alpha/no-frontmatter.md skipped");
    expect(warnings).toContain("alpha/bad-order.md skipped");
  });

  it("warns about a file name that is not a slug", () => {
    expect(warnings).toContain("alpha/Bad_Name.md skipped");
  });

  it("uses defaults for a missing or invalid _section.json", () => {
    const beta = content.sections.find((s) => s.slug === "beta")!;
    expect(beta.title).toBe("Beta");
    expect(beta.order).toBe(999);
    expect(warnings).toContain("beta/_section.json is missing");
    expect(warnings).toContain("gamma/_section.json is not valid JSON");
  });

  it("hides a section that has no valid pages", () => {
    expect(content.sections.find((s) => s.slug === "delta")).toBeUndefined();
    expect(warnings).toContain('section "delta" has no valid pages');
  });
});

describe("loadHelpContentFrom (no folder)", () => {
  it("returns an empty guide and a warning", () => {
    const content = loadHelpContentFrom(path.join(FIXTURES, "does-not-exist"));
    expect(content.sections).toEqual([]);
    expect(content.warnings[0]).toContain("content folder not found");
  });
});

describe("localImageExists", () => {
  it("checks /help/img files against the image folder", () => {
    const dir = path.join(FIXTURES, "good", "getting-started");
    expect(localImageExists("/help/img/welcome.md", dir)).toBe(true);
    expect(localImageExists("/help/img/nope.png", dir)).toBe(false);
  });

  it("does not judge addresses outside /help/img", () => {
    expect(localImageExists("https://example.com/a.png")).toBeUndefined();
    expect(localImageExists("/help/img/../secret.png")).toBeUndefined();
  });
});
