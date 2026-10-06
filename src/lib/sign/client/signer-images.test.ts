import { describe, expect, it } from "vitest";

import { MAX_IMAGE_BYTES } from "../rules";
import { checkImageDataUrl, dataUrlBytes, fitWithin, nextSmaller, padBounds, sniffImage, TARGET_IMAGE_BYTES, trimBounds } from "./signer-images";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString("base64");

describe("data URLs", () => {
  it("counts the bytes behind the base64", () => {
    expect(dataUrlBytes("data:image/png;base64,QUJD")).toBe(3);
    expect(dataUrlBytes("data:image/png;base64,QUI=")).toBe(2);
    expect(dataUrlBytes("data:image/png;base64,QQ==")).toBe(1);
    expect(dataUrlBytes("nonsense")).toBe(0);
  });
  it("reads what an image really is from its first bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(`data:image/jpeg;base64,${JPEG_HEAD}`)).toBe("image/jpeg");
    expect(sniffImage(`data:image/jpeg;base64,${JPEG_HEAD}`.replace("jpeg", "png"))).toBe("image/jpeg");
    expect(sniffImage("data:image/png;base64,QUJDREVGR0g=")).toBeNull();
  });
  it("accepts what the server accepts and refuses what it refuses", () => {
    expect(checkImageDataUrl(PNG)).toBe(true);
    expect(checkImageDataUrl(`data:image/jpeg;base64,${JPEG_HEAD}`)).toBe(true);
    // claims jpeg, is png
    expect(checkImageDataUrl(PNG.replace("png", "jpeg"))).toBe(false);
    expect(checkImageDataUrl("data:image/gif;base64,R0lGODlh")).toBe(false);
    expect(checkImageDataUrl(42)).toBe(false);
    expect(checkImageDataUrl("data:image/png;base64,")).toBe(false);
  });
  it("refuses a picture over the limit", () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(MAX_IMAGE_BYTES + 10)]).toString("base64");
    expect(checkImageDataUrl(`data:image/png;base64,${big}`)).toBe(false);
    const fits = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(MAX_IMAGE_BYTES - 4)]).toString("base64");
    expect(checkImageDataUrl(`data:image/png;base64,${fits}`)).toBe(true);
    expect(TARGET_IMAGE_BYTES).toBeLessThan(MAX_IMAGE_BYTES);
  });
});

describe("sizes", () => {
  it("scales down to fit and never up", () => {
    expect(fitWithin(1200, 400, 600, 200)).toEqual({ width: 600, height: 200 });
    expect(fitWithin(1200, 800, 600, 200)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(300, 100, 600, 200)).toEqual({ width: 300, height: 100 });
    expect(fitWithin(0, 0, 600, 200)).toEqual({ width: 1, height: 1 });
  });
  it("finds the ink", () => {
    const w = 6;
    const h = 4;
    const px = new Uint8ClampedArray(w * h * 4);
    const ink = (x: number, y: number) => (px[(y * w + x) * 4 + 3] = 255);
    expect(trimBounds(px, w, h)).toBeNull();
    ink(2, 1);
    ink(4, 2);
    expect(trimBounds(px, w, h)).toEqual({ x: 2, y: 1, width: 3, height: 2 });
  });
  it("pads inside the canvas", () => {
    expect(padBounds({ x: 2, y: 1, width: 3, height: 2 }, 4, 6, 4)).toEqual({ x: 0, y: 0, width: 6, height: 4 });
    expect(padBounds({ x: 10, y: 10, width: 20, height: 5 }, 2, 100, 100)).toEqual({ x: 8, y: 8, width: 24, height: 9 });
  });
  it("shrinks in steps and stops", () => {
    expect(nextSmaller({ width: 600, height: 200 })).toEqual({ width: 480, height: 160 });
    expect(nextSmaller({ width: 30, height: 9 })).toBeNull();
  });
});
