import { describe, expect, it } from "vitest";

import { imageKind } from "./filing-data";

describe("imageKind", () => {
  it("recognises JPEG and PNG by their first bytes, not by their name", () => {
    expect(imageKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpg");
    expect(imageKind(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("png");
  });
  it("leaves out anything else (a PDF cannot hold WebP, HEIC or GIF)", () => {
    expect(imageKind(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57]))).toBeNull(); // RIFF/WEBP
    expect(imageKind(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0]))).toBeNull(); // GIF
    expect(imageKind(new Uint8Array())).toBeNull();
  });
});
