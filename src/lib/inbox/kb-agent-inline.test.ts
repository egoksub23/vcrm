import { describe, expect, it } from "vitest";

import { appendLinkLines, planKbFile, stageKbFiles, type StagedKbFile } from "./kb-agent";

const att = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  file_name: `${id}.png`,
  mime_type: "image/png",
  size_bytes: 100,
  url: `https://cdn/${id}.png`,
  storage_path: `account-a/kb/${id}.png`,
  kind: "image" as const,
  inline: true,
  caption: null as string | null,
  ...over,
});

describe("stageKbFiles with an article's inline images", () => {
  it("stages them in the order given, with their caption and inline flag", () => {
    const out = stageKbFiles([], [att("a", { caption: "Step 1" }), att("b")], "kb");
    expect(out.map((f) => f.key)).toEqual(["a", "b"]);
    expect(out[0]).toMatchObject({ caption: "Step 1", inline: true, origin: "kb", kind: "image" });
    expect(out[1].caption).toBeNull();
  });

  it("leaves them out for an email reply, whose text already holds them (other files still come)", () => {
    const pdf = att("doc", { kind: "document", mime_type: "application/pdf", inline: false });
    const out = stageKbFiles([], [att("a"), pdf, att("b")], "kb", { skipInline: true });
    expect(out.map((f) => f.key)).toEqual(["doc"]);
  });

  it("does not stage the same picture twice", () => {
    const first = stageKbFiles([], [att("a")], "kb");
    expect(stageKbFiles(first, [att("a")], "ai")).toHaveLength(1);
  });

  it("still accepts files from an older response that carries no inline or caption", () => {
    const old = { id: "x", file_name: "x.pdf", mime_type: "application/pdf", size_bytes: 1, url: "u", storage_path: "p", kind: "document" as const };
    expect(stageKbFiles([], [old], "kb")[0]).toMatchObject({ inline: false, caption: null });
  });
});

describe("appendLinkLines with captions", () => {
  it("names a captioned image by its caption", () => {
    expect(
      appendLinkLines("Hi", [
        { fileName: "pasted-image-1.png", url: "https://x/1.png", caption: "The menu" },
        { fileName: "b.png", url: "https://x/2.png", caption: null },
      ]),
    ).toBe("Hi\n\nThe menu: https://x/1.png\nb.png: https://x/2.png");
  });
});

describe("a pasted image chip is planned like any other image", () => {
  const pasted = (mimeType: string): Pick<StagedKbFile, "kind" | "mimeType"> => ({ kind: "image", mimeType });

  it("goes out as an image message on WhatsApp, Messenger and Instagram", () => {
    expect(planKbFile("whatsapp", pasted("image/png"))).toEqual({ mode: "media", kind: "image" });
    expect(planKbFile("whatsapp", pasted("image/jpeg"))).toEqual({ mode: "media", kind: "image" });
    expect(planKbFile("messenger", pasted("image/png"))).toEqual({ mode: "media", kind: "image" });
    expect(planKbFile("instagram", pasted("image/jpeg"))).toEqual({ mode: "media", kind: "image" });
  });

  it("is an attachment on its own message for email and a link line on the web chat", () => {
    expect(planKbFile("email", pasted("image/png"))).toEqual({ mode: "media", kind: "image" });
    expect(planKbFile("gmail", pasted("image/png"))).toEqual({ mode: "media", kind: "image" });
    expect(planKbFile("web_widget", pasted("image/png"))).toEqual({ mode: "link" });
  });

  it("goes out as a document on WhatsApp when it is a WebP (WhatsApp images are PNG or JPEG)", () => {
    expect(planKbFile("whatsapp", pasted("image/webp"))).toEqual({ mode: "media", kind: "document" });
  });
});
