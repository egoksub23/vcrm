import { describe, expect, it } from "vitest";
import { createSearchIndex, makeSnippet, searchGuide } from "./search";
import type { HelpSearchDoc } from "./types";

const docs: HelpSearchDoc[] = [
  {
    id: "/help/inbox/reply-to-customers",
    title: "Reply to customers",
    section: "Inbox",
    description: "Send text, emoji, files and voice notes.",
    headings: "Send a message\nWhatsApp templates and the 24-hour window",
    body: "Type your message in the box and press Enter. Use a template when the 24-hour window has closed.",
  },
  {
    id: "/help/inbox/close-and-reopen",
    title: "Close and reopen a chat",
    section: "Inbox",
    description: "Close a conversation with a note.",
    headings: "Close a chat\nReopen",
    body: "Click Close. A closing note is required. The session log records who closed the chat.",
  },
  {
    id: "/help/tickets/create-a-ticket",
    title: "Create a ticket",
    section: "Tickets",
    description: "Turn a chat into a ticket.",
    headings: "From a chat",
    body: "Open the chat and choose Create ticket. Fill in the subject.",
  },
];
const index = createSearchIndex(docs);
const ids = (q: string) => searchGuide(index, q).map((h) => h.id);

describe("searchGuide", () => {
  it("finds a page by a word in its title, ranked first", () => {
    expect(ids("ticket")[0]).toBe("/help/tickets/create-a-ticket");
  });

  it("matches words that only appear in the body", () => {
    expect(ids("session log")).toEqual(["/help/inbox/close-and-reopen"]);
  });

  it("matches prefixes as you type", () => {
    expect(ids("reop")).toContain("/help/inbox/close-and-reopen");
  });

  it("forgives a small typo in longer words", () => {
    expect(ids("templete")).toContain("/help/inbox/reply-to-customers");
  });

  it("finds words that only appear in a heading", () => {
    expect(ids("24-hour")).toContain("/help/inbox/reply-to-customers");
  });

  it("ignores filler words like how and to", () => {
    expect(ids("how to reply")[0]).toBe("/help/inbox/reply-to-customers");
  });

  it("returns nothing for an empty or unmatched query", () => {
    expect(ids("")).toEqual([]);
    expect(ids("   ")).toEqual([]);
    expect(ids("zzzqqq")).toEqual([]);
  });

  it("returns title, section, link and a snippet around the match", () => {
    const [hit] = searchGuide(index, "closing note");
    expect(hit).toMatchObject({ title: "Close and reopen a chat", section: "Inbox", href: hit.id });
    expect(hit.snippet.match.toLowerCase()).toBe("closing");
    expect(hit.snippet.before + hit.snippet.match + hit.snippet.after).toContain("closing note is required");
  });

  it("respects the limit", () => {
    expect(searchGuide(index, "chat", 1)).toHaveLength(1);
  });
});

describe("makeSnippet", () => {
  const long = `${"word ".repeat(60)}needle ${"tail ".repeat(60)}`;

  it("centres on the first match and adds ellipses when trimmed", () => {
    const s = makeSnippet(long, ["needle"]);
    expect(s.match).toBe("needle");
    expect(s.before.startsWith("…")).toBe(true);
    expect(s.after.endsWith("…")).toBe(true);
    expect(s.before.length).toBeLessThan(90);
  });

  it("matches case-insensitively and keeps the original casing", () => {
    expect(makeSnippet("Open the Inbox now", ["inbox"]).match).toBe("Inbox");
  });

  it("falls back to the start of the text when nothing matches", () => {
    const s = makeSnippet("Hello world", ["zzz"]);
    expect(s).toEqual({ before: "Hello world", match: "", after: "" });
  });
});
