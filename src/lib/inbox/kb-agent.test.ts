import { describe, expect, it } from "vitest";

import {
  appendBelow,
  appendLinkLines,
  buildKnowledgeQuery,
  parseAiSourcesNote,
  parseKbCommand,
  planKbFile,
  stageKbFiles,
  type StagedKbFile,
} from "./kb-agent";

const msg = (sender_type: "customer" | "agent", content_text: string, is_internal = false) => ({
  sender_type,
  content_text,
  is_internal,
});

describe("buildKnowledgeQuery", () => {
  it("joins the last three customer messages in order", () => {
    const q = buildKnowledgeQuery([
      msg("customer", "one"),
      msg("customer", "two"),
      msg("agent", "reply"),
      msg("customer", "three"),
      msg("customer", "four"),
    ]);
    expect(q).toBe("two\nthree\nfour");
  });

  it("skips agent messages, internal comments and blanks", () => {
    expect(
      buildKnowledgeQuery([msg("customer", "hi"), msg("customer", "secret", true), msg("customer", "  ")]),
    ).toBe("hi");
    expect(buildKnowledgeQuery([])).toBe("");
  });

  it("stops adding older messages once about 500 characters are reached", () => {
    const long = "x".repeat(400);
    const q = buildKnowledgeQuery([msg("customer", long), msg("customer", long)]);
    expect(q).toBe(long);
  });
});

describe("parseKbCommand", () => {
  it("recognises /kb with and without a query", () => {
    expect(parseKbCommand("/kb")).toEqual({ query: "" });
    expect(parseKbCommand("/kb ")).toEqual({ query: "" });
    expect(parseKbCommand("/kb yearly plan")).toEqual({ query: "yearly plan" });
    expect(parseKbCommand("  /KB refund")).toEqual({ query: "refund" });
  });

  it("ignores everything else", () => {
    expect(parseKbCommand("hello /kb yearly")).toBeNull();
    expect(parseKbCommand("/kbx")).toBeNull();
    expect(parseKbCommand("/kb yearly\nmore text")).toBeNull();
    expect(parseKbCommand("")).toBeNull();
  });
});

const att = (id: string, url: string, kind: "image" | "document" = "document") => ({
  id,
  file_name: `${id}.pdf`,
  mime_type: "application/pdf",
  size_bytes: 10,
  url,
  storage_path: `account-1/kb/${id}.pdf`,
  kind,
});

describe("stageKbFiles", () => {
  it("adds files in order and skips duplicates by URL", () => {
    const first = stageKbFiles([], [att("a", "u1"), att("b", "u2")], "kb");
    expect(first.map((f) => f.key)).toEqual(["a", "b"]);
    const second = stageKbFiles(first, [att("b2", "u2"), att("c", "u3")], "ai");
    expect(second.map((f) => f.key)).toEqual(["a", "b", "c"]);
    expect(second[2].origin).toBe("ai");
    expect(second[2].storagePath).toBe("account-1/kb/c.pdf");
    // The input list is never mutated.
    expect(first).toHaveLength(2);
  });

  it("ignores attachments with no URL", () => {
    expect(stageKbFiles([], [att("a", "")], "kb")).toEqual([]);
  });
});

describe("planKbFile", () => {
  const file = (kind: StagedKbFile["kind"], mimeType: string) => ({ kind, mimeType });

  it("sends a link on the web widget", () => {
    expect(planKbFile("web_widget", file("image", "image/png"))).toEqual({ mode: "link" });
  });

  it("sends Instagram documents as a link but images as media", () => {
    expect(planKbFile("instagram", file("document", "application/pdf"))).toEqual({ mode: "link" });
    expect(planKbFile("instagram", file("image", "image/jpeg"))).toEqual({ mode: "media", kind: "image" });
  });

  it("falls back to a document on WhatsApp for types it rejects as media", () => {
    expect(planKbFile("whatsapp", file("image", "image/png"))).toEqual({ mode: "media", kind: "image" });
    expect(planKbFile("whatsapp", file("image", "image/gif"))).toEqual({ mode: "media", kind: "document" });
    expect(planKbFile("whatsapp", file("video", "video/webm"))).toEqual({ mode: "media", kind: "document" });
    expect(planKbFile("whatsapp", file("audio", "audio/ogg; codecs=opus"))).toEqual({
      mode: "media",
      kind: "audio",
    });
    expect(planKbFile("whatsapp", file("document", "application/vnd.ms-powerpoint"))).toEqual({
      mode: "media",
      kind: "document",
    });
  });

  it("keeps the natural kind on Messenger and email", () => {
    expect(planKbFile("messenger", file("document", "application/pdf"))).toEqual({
      mode: "media",
      kind: "document",
    });
    expect(planKbFile("email", file("image", "image/png"))).toEqual({ mode: "media", kind: "image" });
    expect(planKbFile("gmail", file("document", "application/pdf"))).toEqual({
      mode: "media",
      kind: "document",
    });
  });
});

describe("appendLinkLines", () => {
  it("adds one line per file below the text", () => {
    expect(appendLinkLines("Hello", [{ fileName: "a.pdf", url: "https://x/a.pdf" }])).toBe(
      "Hello\n\na.pdf: https://x/a.pdf",
    );
  });

  it("works when there is no text and leaves the text alone with no files", () => {
    expect(appendLinkLines("", [{ fileName: "a.pdf", url: "u" }])).toBe("a.pdf: u");
    expect(appendLinkLines("Hello", [])).toBe("Hello");
  });
});

describe("appendBelow", () => {
  it("puts new text on its own line unless the box already ends in whitespace", () => {
    expect(appendBelow("", "abc")).toBe("abc");
    expect(appendBelow("Hi", "abc")).toBe("Hi\nabc");
    expect(appendBelow("Hi\n", "abc")).toBe("Hi\nabc");
  });
});

describe("parseAiSourcesNote", () => {
  it("reads linked sources", () => {
    const note = parseAiSourcesNote(
      "AI answered from: [Business hours](kb:11111111-2222-3333-4444-555555555555), [Refunds](/knowledge/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)",
    );
    expect(note?.sources).toEqual([
      { title: "Business hours", id: "11111111-2222-3333-4444-555555555555" },
      { title: "Refunds", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ]);
  });

  it("reads plain titles, with or without quotes and the Internal prefix", () => {
    expect(parseAiSourcesNote("AI answered from: Business hours, Refunds")?.sources).toEqual([
      { title: "Business hours", id: null },
      { title: "Refunds", id: null },
    ]);
    expect(parseAiSourcesNote('Internal: AI answered from "Business hours"')?.sources).toEqual([
      { title: "Business hours", id: null },
    ]);
  });

  it("returns null for other comments", () => {
    expect(parseAiSourcesNote("Please call her back")).toBeNull();
    expect(parseAiSourcesNote("AI answered from:")).toBeNull();
    expect(parseAiSourcesNote(null)).toBeNull();
  });
});
