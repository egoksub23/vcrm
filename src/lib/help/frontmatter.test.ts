import { describe, expect, it } from "vitest";
import { isValidIsoDate, parseFrontmatter, splitFrontmatter, validateFrontmatter } from "./frontmatter";

describe("splitFrontmatter", () => {
  it("reads key/value lines and returns the body", () => {
    const r = splitFrontmatter("---\ntitle: Hello\norder: 2\n---\n\nBody text\n");
    expect(r).toEqual({ ok: true, value: { data: { title: "Hello", order: "2" }, body: "Body text\n" } });
  });

  it("handles CRLF and a byte-order mark", () => {
    const r = splitFrontmatter("﻿---\r\ntitle: Hi\r\n---\r\nBody");
    expect(r.ok && r.value.data.title).toBe("Hi");
    expect(r.ok && r.value.body).toBe("Body");
  });

  it("strips quotes and trailing comments, keeps colons in plain values", () => {
    const r = splitFrontmatter(
      "---\ntitle: \"Quoted: yes\"\ndescription: Use this: it works\nupdated: 2026-09-21      # optional\nother: 'it''s'\n---\n",
    );
    expect(r.ok && r.value.data).toEqual({
      title: "Quoted: yes",
      description: "Use this: it works",
      updated: "2026-09-21",
      other: "it's",
    });
  });

  it("keeps a # that is inside quotes", () => {
    const r = splitFrontmatter('---\ntitle: "Tag #1"\n---\n');
    expect(r.ok && r.value.data.title).toBe("Tag #1");
  });

  it("fails without a frontmatter block", () => {
    expect(splitFrontmatter("No frontmatter").ok).toBe(false);
    expect(splitFrontmatter("---\ntitle: x\nno end").ok).toBe(false);
  });

  it("fails on a line that is not key: value", () => {
    const r = splitFrontmatter("---\njust some words\n---\n");
    expect(r.ok).toBe(false);
  });
});

describe("validateFrontmatter", () => {
  const base = { title: "T", description: "D", order: "1" };

  it("accepts the required keys", () => {
    expect(validateFrontmatter(base)).toEqual({ ok: true, value: { title: "T", description: "D", order: 1 } });
  });

  it("keeps a valid updated date", () => {
    const r = validateFrontmatter({ ...base, updated: "2026-09-21" });
    expect(r.ok && r.value.updated).toBe("2026-09-21");
  });

  it.each([
    [{ ...base, title: "" }, "title"],
    [{ ...base, description: " " }, "description"],
    [{ title: "T", description: "D" }, "order"],
    [{ ...base, order: "first" }, "whole number"],
    [{ ...base, order: "-1" }, "whole number"],
    [{ ...base, updated: "21/09/2026" }, "ISO date"],
    [{ ...base, updated: "2026-02-31" }, "ISO date"],
  ])("rejects %j", (data, fragment) => {
    const r = validateFrontmatter(data as Record<string, string>);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(fragment);
  });
});

describe("isValidIsoDate", () => {
  it("checks real calendar dates", () => {
    expect(isValidIsoDate("2026-09-21")).toBe(true);
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2026-02-29")).toBe(false);
  });
});

describe("parseFrontmatter", () => {
  it("combines split and validation", () => {
    const ok = parseFrontmatter("---\ntitle: A\ndescription: B\norder: 3\n---\nHi");
    expect(ok.ok && ok.value.meta.order).toBe(3);
    expect(ok.ok && ok.value.body).toBe("Hi");
    expect(parseFrontmatter("---\ntitle: A\n---\nHi").ok).toBe(false);
  });
});
