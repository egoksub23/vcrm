import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import type { IncidentAttachment } from "@/lib/incidents/types";
import { EvidenceGallery, isPicture } from "./evidence-gallery";

vi.mock("@/hooks/use-signed-media-url", () => ({ useSignedMediaUrl: (url: string) => ({ src: url, status: "ready" }) }));

const messages = JSON.parse(readFileSync(join(process.cwd(), "messages", "en.json"), "utf8"));
const att = (over: Partial<IncidentAttachment>): IncidentAttachment => ({
  id: "a1", incident_id: "i1", comment_id: null, storage_path: "p", url: "https://x/a.jpg", filename: "a.jpg", mime_type: "image/jpeg", size_bytes: 100, uploaded_by: "u1", created_at: "2026-11-09T04:00:00.000Z", file_hash: null, ...over,
});

describe("isPicture", () => {
  it("goes by the reported type, or the file name when none was reported", () => {
    expect(isPicture(att({}))).toBe(true);
    expect(isPicture(att({ mime_type: "application/octet-stream", filename: "IMG_1.PNG" }))).toBe(true);
    expect(isPicture(att({ mime_type: "application/pdf", filename: "scan.pdf" }))).toBe(false);
  });
});

describe("EvidenceGallery", () => {
  it("shows each picture as a small square you can click, and nothing when there are none", () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages} onError={(e: Error) => { throw e; }}>
        <EvidenceGallery pictures={[att({}), att({ id: "a2", filename: "b.png", url: "https://x/b.png" })]} />
        <EvidenceGallery pictures={[]} />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('src="https://x/a.jpg"');
    expect(html).toContain('src="https://x/b.png"');
    expect(html.match(/<button/g)?.length).toBe(2);
  });
});
