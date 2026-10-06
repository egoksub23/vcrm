import { describe, expect, it } from "vitest";

import { normalizeRotation, offsetToUser, pageShownSize, shownBoxToUser } from "./geometry";

describe("normalizeRotation", () => {
  it("accepts multiples of 90 in either direction", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(180)).toBe(180);
  });
});

describe("shownBoxToUser", () => {
  // A box in the top-left quarter of the shown page, 100 wide and 40 high in a 600 x 800 page.
  const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.05 };

  it("upright: the origin is the box's bottom-left corner in PDF space", () => {
    const u = shownBoxToUser(box, 600, 800, 0);
    expect(u).toEqual({ x: 60, y: 800 - (80 + 40), w: 120, h: 40, angle: 0 });
  });

  it("rotated 90: shown width and height swap, text runs up the page", () => {
    // media 600 x 800 shown as 800 x 600
    const u = shownBoxToUser(box, 600, 800, 90);
    expect(u.w).toBeCloseTo(160); // 0.2 * 800
    expect(u.h).toBeCloseTo(30); // 0.05 * 600
    expect(u.angle).toBe(90);
    // shown (vx, vy+h) = (80, 60+30) -> user x = 90, y = 80
    expect(u.x).toBeCloseTo(90);
    expect(u.y).toBeCloseTo(80);
  });

  it("rotated 180 and 270 land on the opposite edges", () => {
    const a = shownBoxToUser(box, 600, 800, 180);
    expect(a.angle).toBe(180);
    expect(a.x).toBeCloseTo(600 - 60);
    expect(a.y).toBeCloseTo(80 + 40);
    const b = shownBoxToUser(box, 600, 800, 270);
    expect(b.angle).toBe(270);
    expect(b.x).toBeCloseTo(600 - 90);
    expect(b.y).toBeCloseTo(800 - 80);
  });

  it("a point shown at the page centre stays at the centre of user space in every rotation", () => {
    for (const r of [0, 90, 180, 270] as const) {
      const shown = pageShownSize(600, 800, r);
      // a zero-size box at the shown centre
      const u = shownBoxToUser({ x: 0.5, y: 0.5, w: 0, h: 0 }, 600, 800, r);
      expect(shown.width * shown.height).toBe(480000);
      expect(u.x).toBeCloseTo(300);
      expect(u.y).toBeCloseTo(400);
    }
  });
});

describe("offsetToUser", () => {
  it("turns a shown right/up offset into user space", () => {
    expect(offsetToUser(10, 5, 0)).toEqual({ x: 10, y: 5 });
    expect(offsetToUser(10, 5, 90)).toEqual({ x: -5, y: 10 });
    expect(offsetToUser(10, 5, 180)).toEqual({ x: -10, y: -5 });
    expect(offsetToUser(10, 5, 270)).toEqual({ x: 5, y: -10 });
  });
});
