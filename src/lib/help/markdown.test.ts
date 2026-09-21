import { describe, expect, it } from "vitest";
import { renderMarkdown, slugify } from "./markdown";

describe("headings and anchors", () => {
  it("gives h2 and h3 an id and an anchor link, and lists them for the outline", () => {
    const r = renderMarkdown("## Send a reply\n\ntext\n\n### Before you start\n\n#### Small");
    expect(r.html).toContain('<h2 id="send-a-reply">Send a reply<a class="help-anchor" href="#send-a-reply"');
    expect(r.html).toContain('<h3 id="before-you-start">');
    expect(r.html).toContain("<h4>Small</h4>");
    expect(r.headings).toEqual([
      { id: "send-a-reply", text: "Send a reply", depth: 2 },
      { id: "before-you-start", text: "Before you start", depth: 3 },
    ]);
  });

  it("de-duplicates repeated heading ids", () => {
    const r = renderMarkdown("## Tips\n\n## Tips\n\n## Tips");
    expect(r.headings.map((h) => h.id)).toEqual(["tips", "tips-1", "tips-2"]);
  });

  it("uses plain text for the outline when the heading has formatting", () => {
    const r = renderMarkdown("## Press **Send** or `Enter`");
    expect(r.headings[0].text).toBe("Press Send or Enter");
  });

  it("renders a body h1 as h2", () => {
    const r = renderMarkdown("# Big");
    expect(r.html).toContain('<h2 id="big">');
  });

  it("slugifies like GitHub", () => {
    expect(slugify("What's new? (v0.49)")).toBe("whats-new-v049");
    expect(slugify("!!!")).toBe("section");
  });
});

describe("callouts", () => {
  it.each([
    ["NOTE", "note", "Note"],
    ["TIP", "tip", "Tip"],
    ["WARNING", "warning", "Warning"],
    ["IMPORTANT", "important", "Important"],
    ["CAUTION", "warning", "Warning"],
  ])("renders [!%s]", (marker, kind, title) => {
    const r = renderMarkdown(`> [!${marker}]\n> Do not share **private** details.`);
    expect(r.html).toContain(`data-callout="${kind}"`);
    expect(r.html).toContain(`<span>${title}</span>`);
    expect(r.html).toContain("<strong>private</strong>");
    expect(r.html).not.toContain("[!");
    expect(r.warnings).toEqual([]);
  });

  it("supports the marker and text on the same line, and several paragraphs", () => {
    const r = renderMarkdown("> [!NOTE] Same line.\n>\n> Second paragraph.");
    expect(r.html).toContain("Same line.");
    expect(r.html).toContain("Second paragraph.");
    expect(r.html).not.toContain("[!NOTE]");
  });

  it("supports a marker on its own line followed by a new paragraph", () => {
    const r = renderMarkdown("> [!TIP]\n>\n> Only in a new paragraph.");
    expect(r.html).toContain('data-callout="tip"');
    expect(r.html).toContain("<p>Only in a new paragraph.</p>");
  });

  it("uses translated titles", () => {
    const r = renderMarkdown("> [!NOTE]\n> x", {
      labels: { callouts: { note: "Catatan", tip: "", warning: "", important: "" } },
    });
    expect(r.html).toContain("<span>Catatan</span>");
  });

  it("leaves a normal blockquote alone", () => {
    const r = renderMarkdown("> Just a quote.");
    expect(r.html).toContain("<blockquote>");
    expect(r.html).not.toContain("help-callout");
  });

  it("warns about an unknown marker and keeps a blockquote", () => {
    const r = renderMarkdown("> [!DANGER]\n> Careful.");
    expect(r.html).toContain("<blockquote>");
    expect(r.warnings.join(" ")).toContain("[!DANGER]");
  });

  it("keeps lists inside callouts", () => {
    const r = renderMarkdown("> [!IMPORTANT]\n> Check:\n>\n> - one\n> - two");
    expect(r.html).toContain("<li>one</li>");
  });
});

describe("images", () => {
  const md = "![Inbox with a chat open](/help/img/inbox-01-list.png)";

  it("renders a zoomable figure with the alt text as caption", () => {
    const r = renderMarkdown(md, { imageExists: () => true });
    expect(r.html).toContain("data-help-zoom");
    expect(r.html).toContain('<img src="/help/img/inbox-01-list.png" alt="Inbox with a chat open" loading="lazy"');
    expect(r.html).toContain('<span class="help-caption">Inbox with a chat open</span>');
    expect(r.images).toEqual(["/help/img/inbox-01-list.png"]);
  });

  it("renders a placeholder that names the file when the image is missing (development)", () => {
    const r = renderMarkdown(md, { imageExists: () => false, showMissingFileName: true });
    expect(r.html).toContain("help-figure-missing");
    expect(r.html).toContain("Screenshot not added yet: inbox-01-list.png");
    expect(r.html).not.toContain("<img");
    expect(r.html).toContain("Inbox with a chat open");
  });

  it("hides the file name in production", () => {
    const r = renderMarkdown(md, { imageExists: () => false, showMissingFileName: false });
    expect(r.html).toContain("help-figure-missing");
    expect(r.html).not.toContain("Screenshot not added yet");
  });

  it("drops images with unsafe addresses", () => {
    const r = renderMarkdown("![x](javascript:alert(1))");
    expect(r.html).not.toContain("javascript:");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("escapes the alt text", () => {
    const r = renderMarkdown('![a "quoted" <b>](/help/img/x.png)', { imageExists: () => true });
    expect(r.html).not.toContain("<b>");
  });
});

describe("links", () => {
  it("collects links and marks external ones", () => {
    const r = renderMarkdown("[a](/help/inbox/inbox-overview) [b](https://example.com) [c](#top) [d](mailto:a@b.co)");
    expect(r.links).toEqual(["/help/inbox/inbox-overview", "https://example.com", "#top", "mailto:a@b.co"]);
    expect(r.html).toContain('<a href="/help/inbox/inbox-overview">a</a>');
    expect(r.html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(r.html.match(/target="_blank"/g)?.length).toBe(1);
  });

  it("removes javascript: and protocol-relative links but keeps the text", () => {
    const r = renderMarkdown("[click](javascript:alert(1)) and [x](//evil.example)");
    expect(r.html).not.toContain("javascript:");
    expect(r.html).not.toContain("evil.example");
    expect(r.html).toContain("click");
    expect(r.warnings.length).toBe(2);
  });
});

describe("raw HTML", () => {
  it("keeps <kbd> and other allow-listed tags without attributes", () => {
    const r = renderMarkdown('Press <kbd class="x" onclick="alert(1)">Ctrl</kbd>+<kbd>K</kbd>.');
    expect(r.html).toContain("<kbd>Ctrl</kbd>+<kbd>K</kbd>");
    expect(r.html).not.toContain("onclick");
  });

  it("removes script blocks including their content", () => {
    const r = renderMarkdown("Hello\n\n<script>alert(1)</script>\n\nWorld");
    expect(r.html).not.toContain("script");
    expect(r.html).not.toContain("alert");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("removes unsupported tags (iframe, img with handlers, div)", () => {
    const r = renderMarkdown(
      '<div onclick="x()">hi</div>\n\n<iframe src="https://e.com"></iframe>\n\ntext <img src=x onerror=alert(1)> end',
    );
    expect(r.html).not.toMatch(/<(div|iframe|img)/);
    expect(r.html).not.toContain("onerror");
    expect(r.html).not.toContain("onclick");
  });

  it("turns a stray unterminated tag into text", () => {
    const r = renderMarkdown("<div\n\nplain");
    expect(r.html).not.toMatch(/<div/);
  });
});

describe("steps, tables, code", () => {
  it("styles numbered lists as steps but not bullet lists", () => {
    const r = renderMarkdown("1. One\n2. Two\n\n- a\n- b");
    expect(r.html).toContain('<ol class="help-steps">');
    expect(r.html).toContain("<ul>");
  });

  it("renders task lists", () => {
    const r = renderMarkdown("- [x] done\n- [ ] todo");
    expect(r.html).toContain('type="checkbox"');
  });

  it("wraps tables so they scroll on small screens", () => {
    const r = renderMarkdown("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(r.html).toContain('<div class="help-table-wrap"><table>');
  });

  it("renders fenced code with a copy button and escapes it", () => {
    const r = renderMarkdown("```html\n<b>hi</b> & bye\n```");
    expect(r.html).toContain('class="help-code"');
    expect(r.html).toContain("data-help-copy");
    expect(r.html).toContain('<code class="language-html">&lt;b&gt;hi&lt;/b&gt; &amp; bye</code>');
  });
});

describe("plain text for search", () => {
  it("collects headings, paragraphs, list items, table cells and code, without markup", () => {
    const r = renderMarkdown(
      "## Send\n\nType **your** message.\n\n1. Click `Send`\n2. Wait\n\n| Col | Val |\n|---|---|\n| a | b |\n\n> [!NOTE]\n> Careful here.\n\n```\ncode line\n```\n\n<kbd>Ctrl</kbd>",
    );
    expect(r.text).toContain("Send");
    expect(r.text).toContain("Type your message.");
    expect(r.text).toContain("Click Send");
    expect(r.text).toContain("Col Val");
    expect(r.text).toContain("Careful here.");
    expect(r.text).toContain("code line");
    expect(r.text).not.toMatch(/[*`<>]/);
    expect(r.text).not.toContain("[!NOTE]");
  });
});
