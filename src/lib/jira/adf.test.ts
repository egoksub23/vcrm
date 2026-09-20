import { describe, expect, it } from "vitest";

import {
  adfTextLength,
  adfToPlainText,
  adfToSafeHtml,
  buildIssueDescription,
  buildVircleComment,
  htmlToAdf,
  inlineToAdf,
  limitAdf,
  safeHref,
  textToAdf,
  type AdfDoc,
  type AdfNode,
} from "./adf";
import { JIRA_TEXT_MAX } from "./types";

const texts = (nodes: AdfNode[] | undefined): string => (nodes ?? []).map((n) => n.text ?? (n.type === "hardBreak" ? "\n" : "")).join("");

describe("textToAdf", () => {
  it("makes paragraphs from blank lines and hard breaks from single newlines", () => {
    const doc = textToAdf("first line\nsecond line\n\nnew paragraph");
    expect(doc.version).toBe(1);
    expect(doc.content.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    expect(texts(doc.content[0].content)).toBe("first line\nsecond line");
    expect(doc.content[0].content?.some((n) => n.type === "hardBreak")).toBe(true);
  });

  it("handles bold, italic, code and links inline", () => {
    const nodes = inlineToAdf("a **bold** and *italic* and `code` see https://example.com/x.");
    const marks = nodes.map((n) => n.marks?.[0]?.type ?? "none");
    expect(marks).toEqual(["none", "strong", "none", "em", "none", "code", "none", "link", "none"]);
    const link = nodes.find((n) => n.marks?.[0]?.type === "link");
    expect(link?.text).toBe("https://example.com/x");
    expect(link?.marks?.[0].attrs?.href).toBe("https://example.com/x");
    // the sentence's full stop stays outside the link
    expect(nodes[nodes.length - 1].text).toBe(".");
  });

  it("never makes an empty text node", () => {
    const doc = textToAdf("**a****b**\n\n`x`");
    const all = JSON.stringify(doc);
    expect(all).not.toContain('"text":""');
  });

  it("builds lists and code blocks", () => {
    const doc = textToAdf("- one\n- two\n\n1. first\n2. second\n\n```\nlet x = 1;\n\nlet y = 2;\n```");
    expect(doc.content.map((b) => b.type)).toEqual(["bulletList", "orderedList", "codeBlock"]);
    expect(doc.content[0].content).toHaveLength(2);
    expect(doc.content[2].content?.[0].text).toBe("let x = 1;\n\nlet y = 2;");
  });

  it("closes an unterminated code fence instead of losing the text", () => {
    const doc = textToAdf("```\nstill code");
    expect(doc.content[0].type).toBe("codeBlock");
    expect(doc.content[0].content?.[0].text).toBe("still code");
  });

  it("handles empty and whitespace input", () => {
    expect(textToAdf("").content).toEqual([]);
    expect(textToAdf("   \n\n  ").content).toEqual([]);
    expect(textToAdf(null as unknown as string).content).toEqual([]);
  });

  it("does not turn a javascript: address into a link", () => {
    const doc = textToAdf("click javascript:alert(1) or https://ok.example");
    const links = JSON.stringify(doc).match(/"href":"[^"]+"/g) ?? [];
    expect(links).toEqual(['"href":"https://ok.example"']);
  });
});

describe("htmlToAdf", () => {
  it("converts paragraphs, marks, lists, links and code", () => {
    const doc = htmlToAdf(
      '<p>Hello <strong>bold</strong> and <em>it</em> <a href="https://example.com">site</a></p><ul><li>a</li><li>b</li></ul><pre><code>x = 1</code></pre>',
    );
    expect(doc.content.map((b) => b.type)).toEqual(["paragraph", "bulletList", "codeBlock"]);
    const p = doc.content[0].content!;
    expect(p.find((n) => n.marks?.[0]?.type === "strong")?.text).toBe("bold");
    expect(p.find((n) => n.marks?.[0]?.type === "link")?.marks?.[0].attrs?.href).toBe("https://example.com");
    expect(doc.content[2].content?.[0].text).toBe("x = 1");
  });

  it("decodes entities and collapses whitespace", () => {
    const doc = htmlToAdf("<p>Tom &amp;   Jerry &lt;3 &#33;</p>");
    expect(texts(doc.content[0].content)).toBe("Tom & Jerry <3 !");
  });

  it("drops scripts, styles and event handlers, keeping only the text", () => {
    const doc = htmlToAdf('<p onclick="x()">hi<script>alert(1)</script></p><style>p{}</style><iframe src="//evil"></iframe><p>ok</p>');
    const json = JSON.stringify(doc);
    expect(json).not.toContain("alert");
    expect(json).not.toContain("onclick");
    expect(json).not.toContain("evil");
    expect(doc.content.map((b) => texts(b.content))).toEqual(["hi", "ok"]);
  });

  it("refuses unsafe link targets", () => {
    const doc = htmlToAdf('<p><a href="javascript:alert(1)">x</a> <a href="data:text/html;base64,AAA">y</a> <a href="//evil.example">z</a></p>');
    expect(JSON.stringify(doc)).not.toContain('"link"');
  });

  it("survives absurd nesting and huge input without throwing", () => {
    const deep = "<div>".repeat(500) + "text" + "</div>".repeat(500);
    expect(() => htmlToAdf(deep)).not.toThrow();
    expect(() => htmlToAdf("<p>a</p>".repeat(50_000))).not.toThrow();
    expect(() => htmlToAdf("<<<>>><p <b>unclosed")).not.toThrow();
  });
});

describe("limitAdf", () => {
  it("returns a short document unchanged", () => {
    const doc = textToAdf("short");
    const r = limitAdf(doc);
    expect(r.truncated).toBe(false);
    expect(r.doc).toBe(doc);
  });

  it("cuts at the limit and ends with a link to the full text in Vircle", () => {
    const big = textToAdf(Array.from({ length: 50 }, (_, i) => `Paragraph ${i} ` + "x".repeat(2000)).join("\n\n"));
    const r = limitAdf(big, { footerText: "See the full text in Vircle", footerHref: "https://crm.example.com/tickets/1" });
    expect(r.truncated).toBe(true);
    expect(adfTextLength(r.doc)).toBeLessThanOrEqual(JIRA_TEXT_MAX);
    const last = r.doc.content[r.doc.content.length - 1];
    expect(last.content?.[0].text).toContain("See the full text in Vircle");
    expect(last.content?.[0].marks?.[0].attrs?.href).toBe("https://crm.example.com/tickets/1");
  });

  it("does not split a surrogate pair", () => {
    const emoji = "\u{1F600}".repeat(20_000); // 40,000 UTF-16 units
    const r = limitAdf(textToAdf(emoji), { max: 1001 });
    const kept = r.doc.content[0].content?.[0].text ?? "";
    expect(kept.length % 2).toBe(0);
    expect(() => JSON.stringify(r.doc)).not.toThrow();
    for (let i = 0; i < kept.length; i += 2) expect(kept.codePointAt(i)).toBeGreaterThan(0xffff);
  });

  it("keeps the footer even when nothing else fits", () => {
    const r = limitAdf(textToAdf("x".repeat(500)), { max: 20, footerText: "See full text" });
    expect(r.truncated).toBe(true);
    expect(JSON.stringify(r.doc)).toContain("See full text");
  });
});

describe("adfToPlainText (untrusted Jira text)", () => {
  const doc = (content: AdfNode[]): AdfDoc => ({ version: 1, type: "doc", content });

  it("reads paragraphs, lists, code, mentions and cards", () => {
    const text = adfToPlainText(
      doc([
        { type: "paragraph", content: [{ type: "text", text: "Hi " }, { type: "mention", attrs: { id: "1", text: "@Priya" } }, { type: "text", text: "," }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
        { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] }] },
        { type: "codeBlock", content: [{ type: "text", text: "a()" }] },
        { type: "paragraph", content: [{ type: "inlineCard", attrs: { url: "https://acme.atlassian.net/browse/ENG-2" } }] },
      ]),
    );
    expect(text).toBe("Hi @Priya,\n\n• one\n\n1. first\n\n    a()\n\nhttps://acme.atlassian.net/browse/ENG-2");
  });

  it("shows media as a placeholder, never a URL", () => {
    const text = adfToPlainText(doc([{ type: "mediaSingle", content: [{ type: "media", attrs: { alt: "shot.png", id: "abc" } }] }]));
    expect(text).toBe("[attachment: shot.png]");
  });

  it("never returns markup from the input and never throws on garbage", () => {
    expect(adfToPlainText("<img src=x onerror=alert(1)>")).toContain("<img"); // a string stays text, it is not interpreted
    expect(adfToPlainText(null)).toBe("");
    expect(adfToPlainText(42)).toBe("");
    expect(adfToPlainText({ content: "nope" })).toBe("");
    expect(adfToPlainText({ type: "doc", content: [null, 5, "x", { type: "paragraph" }] })).toBe("");
    expect(adfToPlainText({ type: "doc", content: [{ type: "unknownBlock", content: [{ type: "text", text: "kept" }] }] })).toBe("kept");
  });

  it("is bounded for hostile depth and size", () => {
    let node: AdfNode = { type: "text", text: "deep" };
    for (let i = 0; i < 5000; i++) node = { type: "blockquote", content: [node] };
    expect(() => adfToPlainText(doc([node]))).not.toThrow();
    const huge = doc([{ type: "paragraph", content: [{ type: "text", text: "a".repeat(500_000) }] }]);
    expect(adfToPlainText(huge, { max: 1000 }).length).toBe(1000);
  });
});

describe("adfToSafeHtml (untrusted Jira text)", () => {
  it("escapes every character of text", () => {
    const html = adfToSafeHtml({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: '<script>alert("x")</script> & \'q\'' }] }],
    });
    expect(html).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>");
  });

  it("only emits http, https and mailto links, with a safe rel", () => {
    const link = (href: string): AdfDoc["content"][number] => ({
      type: "paragraph",
      content: [{ type: "text", text: "go", marks: [{ type: "link", attrs: { href } }] }],
    });
    const good = adfToSafeHtml({ type: "doc", content: [link("https://example.com/a?b=1&c=2")] });
    expect(good).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(good).toContain('rel="noopener noreferrer nofollow"');
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.example", "/relative"]) {
      expect(adfToSafeHtml({ type: "doc", content: [link(bad)] }), bad).not.toContain("href");
    }
  });

  it("never lets attributes or unknown nodes through", () => {
    const html = adfToSafeHtml({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { onclick: "x()" }, content: [{ type: "text", text: "a", marks: [{ type: "strong", attrs: { style: "x" } }] }] },
        { type: "extension", attrs: { text: "<b>", extensionKey: "evil" }, content: [{ type: "text", text: "<i>t</i>" }] },
      ],
    });
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("style");
    expect(html).not.toMatch(/<(i|b|extension)/);
    expect(html).toContain("&lt;i&gt;t&lt;/i&gt;");
  });

  it("renders headings within 1 to 6 and lists", () => {
    const html = adfToSafeHtml({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 99 }, content: [{ type: "text", text: "h" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] }] },
      ],
    });
    expect(html).toBe("<h6>h</h6><ul><li><p>x</p></li></ul>");
  });
});

describe("what Vircle sends", () => {
  it("builds the description with the ticket text and a link back", () => {
    const { doc, truncated } = buildIssueDescription({
      text: "Customer cannot sign in.\n\n- step one\n- step two",
      ticketKey: "VIR-12",
      ticketUrl: "https://crm.example.com/tickets/abc",
      extraLines: ["Customer: Grace <g@x.test>"],
    });
    expect(truncated).toBe(false);
    const plain = adfToPlainText(doc);
    expect(plain).toContain("Customer cannot sign in.");
    expect(plain).toContain("Customer: Grace");
    expect(plain).toContain("Vircle ticket VIR-12");
    expect(JSON.stringify(doc)).toContain("https://crm.example.com/tickets/abc");
  });

  it("truncates an over-long ticket and links to the full text in Vircle", () => {
    const { doc, truncated } = buildIssueDescription({
      text: Array.from({ length: 100 }, () => "y".repeat(1000)).join("\n\n"),
      ticketKey: "VIR-1",
      ticketUrl: "https://crm.example.com/tickets/x",
    });
    expect(truncated).toBe(true);
    expect(adfTextLength(doc)).toBeLessThanOrEqual(JIRA_TEXT_MAX);
    expect(JSON.stringify(doc)).toContain("https://crm.example.com/tickets/x");
  });

  it("prefixes a comment with the agent's name", () => {
    const { doc } = buildVircleComment({ agentName: "Maya", text: "Please look at this" });
    expect(adfToPlainText(doc)).toBe("Maya (Vircle): Please look at this");
    expect(doc.content[0].content?.[0].marks?.[0].type).toBe("strong");
  });

  it("copes with an agent name that is empty, long or hostile", () => {
    expect(adfToPlainText(buildVircleComment({ agentName: "", text: "x" }).doc)).toContain("Someone (Vircle):");
    const long = adfToPlainText(buildVircleComment({ agentName: "N".repeat(500), text: "x" }).doc);
    expect(long.length).toBeLessThan(140);
    expect(JSON.stringify(buildVircleComment({ agentName: '<img onerror="x">', text: "y" }).doc)).toContain("<img");
  });

  it("safeHref accepts only what it should", () => {
    expect(safeHref("https://a.example")).toBe("https://a.example");
    expect(safeHref("mailto:a@b.example")).toBe("mailto:a@b.example");
    expect(safeHref("javascript:1")).toBeNull();
    expect(safeHref("")).toBeNull();
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref("https://a.example/with space")).toBeNull();
  });
});
