// The screen's pure helpers: the idle cover, the reveal timer, the watermark, the viewer's zoom state and keys, the time words, the recent searches.
// What these tests do NOT cover (no DOM renderer is installed): the timers and event listeners that call them (the 5 s idle check, visibilitychange),
// blob URL creation and revocation, focus movement, and the real browser's right-click and drag handling. See docs/kyc-review.md, "What is tested".

import { describe, expect, it } from "vitest";

import {
  IDLE_COVER_MS,
  INITIAL_VIEW,
  RECENT_MAX,
  REVEAL_MS,
  ZOOM_STEPS,
  addRecent,
  canZoomIn,
  canZoomOut,
  errorKey,
  exactTime,
  loadRecent,
  recentKey,
  relativeTime,
  resetView,
  revealExpired,
  rotate90,
  saveRecent,
  shortId,
  shouldCover,
  toggleFit,
  viewerKey,
  watermarkBackground,
  watermarkText,
  zoomIn,
  zoomLabel,
  zoomOut,
} from "./helpers";

describe("the idle cover", () => {
  const t0 = 1_000_000;
  it("is three minutes", () => expect(IDLE_COVER_MS).toBe(180_000));
  it("shows the image while the reviewer is active", () => {
    expect(shouldCover({ lastActivity: t0, now: t0 + 1_000, hidden: false })).toBe(false);
    expect(shouldCover({ lastActivity: t0, now: t0 + IDLE_COVER_MS - 1, hidden: false })).toBe(false);
  });
  it("covers it after three minutes without interaction", () => {
    expect(shouldCover({ lastActivity: t0, now: t0 + IDLE_COVER_MS, hidden: false })).toBe(true);
    expect(shouldCover({ lastActivity: t0, now: t0 + 10 * IDLE_COVER_MS, hidden: false })).toBe(true);
  });
  it("covers it at once when the tab is hidden, however recent the activity", () => {
    expect(shouldCover({ lastActivity: t0, now: t0, hidden: true })).toBe(true);
  });
  it("takes a different limit when asked", () => {
    expect(shouldCover({ lastActivity: t0, now: t0 + 6_000, hidden: false, idleMs: 5_000 })).toBe(true);
  });
});

describe("the reveal timer", () => {
  it("is two minutes", () => expect(REVEAL_MS).toBe(120_000));
  it("has nothing to expire when nothing is revealed", () => expect(revealExpired(null, 5)).toBe(false));
  it("expires at the end of the two minutes, not before", () => {
    const until = 10_000 + REVEAL_MS;
    expect(revealExpired(until, until - 1)).toBe(false);
    expect(revealExpired(until, until)).toBe(true);
    expect(revealExpired(until, until + 5_000)).toBe(true);
  });
});

describe("the watermark", () => {
  const when = new Date("2026-10-12T03:04:05Z");
  it("reads 'viewer · time · Halo'", () => {
    const text = watermarkText("Aisha Rahman", when, "en");
    expect(text.startsWith("Aisha Rahman · ")).toBe(true);
    expect(text.endsWith(" · Halo")).toBe(true);
    expect(text.split(" · ")).toHaveLength(3);
  });
  it("trims, collapses spaces, caps the name at 40 characters and never leaves it empty", () => {
    expect(watermarkText("  A   B  ", when, "en").startsWith("A B · ")).toBe(true);
    expect(watermarkText("x".repeat(80), when, "en").split(" · ")[0]).toHaveLength(40);
    expect(watermarkText("   ", when, "en").startsWith("? · ")).toBe(true);
  });
  it("copes with an unknown locale", () => {
    expect(() => watermarkText("A", when, "not a locale!!")).not.toThrow();
  });
  it("is an SVG background that repeats, with the text escaped so a name can never add markup", () => {
    const css = watermarkBackground(`<script>alert("x")</script> & 'q'`);
    expect(css.startsWith('url("data:image/svg+xml;utf8,')).toBe(true);
    const svg = decodeURIComponent(css.slice('url("data:image/svg+xml;utf8,'.length, -2));
    expect(svg).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &apos;q&apos;");
    expect(svg).not.toContain("<script");
    expect(svg).toContain("rotate(-28");
    // a double quote in the text cannot end the CSS url("...")
    expect(css.slice(5, -2)).not.toContain('"');
  });
});

describe("the viewer's zoom, rotation and fit", () => {
  it("starts fitted at 100% of the fit, unrotated", () => expect(INITIAL_VIEW).toEqual({ zoom: 1, rotate: 0, fit: true }));

  it("steps up and down through the fixed zoom steps and stops at the ends", () => {
    let s = INITIAL_VIEW;
    const up = [];
    for (let i = 0; i < 12; i++) {
      s = zoomIn(s);
      up.push(s.zoom);
    }
    expect(up.slice(0, 5)).toEqual([1.25, 1.5, 2, 3, 4]);
    expect(Math.max(...up)).toBe(4);
    expect(canZoomIn(s)).toBe(false);
    for (let i = 0; i < 20; i++) s = zoomOut(s);
    expect(s.zoom).toBe(0.25);
    expect(canZoomOut(s)).toBe(false);
    expect(canZoomIn(s)).toBe(true);
    expect(ZOOM_STEPS[0]).toBe(0.25);
  });

  it("zooms from a value between two steps to the next step, never backwards", () => {
    expect(zoomIn({ ...INITIAL_VIEW, zoom: 1.1 }).zoom).toBe(1.25);
    expect(zoomOut({ ...INITIAL_VIEW, zoom: 1.1 }).zoom).toBe(1);
  });

  it("rotates a quarter turn at a time and comes back round", () => {
    let s = INITIAL_VIEW;
    const seen = [];
    for (let i = 0; i < 5; i++) {
      s = rotate90(s);
      seen.push(s.rotate);
    }
    expect(seen).toEqual([90, 180, 270, 0, 90]);
  });

  it("switching between fit and actual size resets the zoom; reset returns to the start", () => {
    const s = toggleFit(zoomIn(INITIAL_VIEW));
    expect(s).toEqual({ zoom: 1, rotate: 0, fit: false });
    expect(toggleFit(s).fit).toBe(true);
    expect(resetView()).toEqual(INITIAL_VIEW);
  });

  it("labels the zoom as a percentage", () => {
    expect(zoomLabel(INITIAL_VIEW)).toBe("100%");
    expect(zoomLabel({ ...INITIAL_VIEW, zoom: 0.25 })).toBe("25%");
    expect(zoomLabel({ ...INITIAL_VIEW, zoom: 1.5 })).toBe("150%");
  });

  it("answers the keyboard shortcuts and leaves every other key to the browser", () => {
    expect(viewerKey(INITIAL_VIEW, "+")?.zoom).toBe(1.25);
    expect(viewerKey(INITIAL_VIEW, "=")?.zoom).toBe(1.25);
    expect(viewerKey(INITIAL_VIEW, "-")?.zoom).toBe(0.75);
    expect(viewerKey({ zoom: 3, rotate: 90, fit: false }, "0")).toEqual(INITIAL_VIEW);
    expect(viewerKey(INITIAL_VIEW, "r")?.rotate).toBe(90);
    expect(viewerKey(INITIAL_VIEW, "R")?.rotate).toBe(90);
    expect(viewerKey(INITIAL_VIEW, "f")?.fit).toBe(false);
    for (const k of ["ArrowDown", "ArrowLeft", "Tab", "Enter", " ", "a", "s", "Escape"]) expect(viewerKey(INITIAL_VIEW, k), k).toBeNull();
  });
});

describe("words for ids and times", () => {
  it("shortens a long id and keeps a short one", () => {
    expect(shortId("val_123")).toBe("val_123");
    expect(shortId("a".repeat(14))).toBe("a".repeat(14));
    expect(shortId("0123456789abcdef-0123")).toBe("01234567…0123");
  });

  const now = Date.parse("2026-10-12T12:00:00Z");
  it("says how long ago, in the person's language", () => {
    expect(relativeTime("2026-10-12T11:59:50Z", now, "en")).toMatch(/10 seconds ago/);
    expect(relativeTime("2026-10-12T11:55:00Z", now, "en")).toBe("5 minutes ago");
    expect(relativeTime("2026-10-12T09:00:00Z", now, "en")).toBe("3 hours ago");
    expect(relativeTime("2026-10-10T12:00:00Z", now, "en")).toBe("2 days ago");
    expect(relativeTime("2026-10-11T12:00:00Z", now, "en")).toBe("yesterday");
    expect(relativeTime("2026-10-12T11:55:00Z", now, "zh")).toMatch(/5/);
    expect(relativeTime("2026-10-12T11:55:00Z", now, "ko")).toMatch(/5/);
  });
  it("falls back to the exact date after about a month, and shows the text itself when it is not a date", () => {
    expect(relativeTime("2026-06-01T00:00:00Z", now, "en")).toBe(exactTime("2026-06-01T00:00:00Z", "en"));
    expect(relativeTime("last Tuesday", now, "en")).toBe("last Tuesday");
    expect(exactTime("last Tuesday", "en")).toBe("last Tuesday");
  });
  it("gives the exact time in the browser's time zone", () => {
    const text = exactTime("2026-10-12T12:00:00Z", "en");
    expect(text).toMatch(/2026/);
    expect(text).toMatch(/\d/);
  });
});

describe("error words", () => {
  it("maps every code the routes and the browser can produce, and anything else to the generic one", () => {
    for (const c of ["not_configured", "upstream_unreachable", "upstream_unauthorized", "not_found", "bad_response", "image_too_large", "image_type_unsupported", "image_host_blocked", "invalid_request", "rate_limited", "forbidden", "audit_failed", "network"]) {
      expect(errorKey(c)).toBe(c);
    }
    expect(errorKey("something_new")).toBe("generic");
    expect(errorKey("")).toBe("generic");
  });
});

describe("recent searches (friend ids only)", () => {
  const valid = (v: string) => /^[A-Za-z0-9._@:+-]{1,100}$/.test(v);
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };

  it("adds the newest first, without duplicates, up to eight", () => {
    let list: string[] = [];
    for (let i = 0; i < 12; i++) list = addRecent(list, `c${i}`);
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0]).toBe("c11");
    expect(addRecent(list, "c9")[0]).toBe("c9");
    expect(addRecent(list, "c9").filter((x) => x === "c9")).toHaveLength(1);
  });

  it("is kept per person and holds nothing but the ids", () => {
    const s = memory();
    saveRecent(s, "u1", ["child-1", "child-2"]);
    saveRecent(s, "u2", ["other"]);
    expect(loadRecent(s, "u1", valid)).toEqual(["child-1", "child-2"]);
    expect(loadRecent(s, "u2", valid)).toEqual(["other"]);
    expect([...s.m.keys()].sort()).toEqual([recentKey("u1"), recentKey("u2")]);
    expect(s.m.get(recentKey("u1"))).toBe('["child-1","child-2"]');
  });

  it("ignores anything stored that is not a valid friend id, or not a list, or not JSON", () => {
    const s = memory();
    s.setItem(recentKey("u"), JSON.stringify(["ok", "bad id", 7, null, "<x>", "fine.2"]));
    expect(loadRecent(s, "u", valid)).toEqual(["ok", "fine.2"]);
    s.setItem(recentKey("u"), '{"a":1}');
    expect(loadRecent(s, "u", valid)).toEqual([]);
    s.setItem(recentKey("u"), "not json");
    expect(loadRecent(s, "u", valid)).toEqual([]);
  });

  it("removes the entry when the list is cleared", () => {
    const s = memory();
    saveRecent(s, "u", ["a"]);
    saveRecent(s, "u", []);
    expect(s.m.size).toBe(0);
  });

  it("works without storage, without a person, and when storage throws", () => {
    expect(loadRecent(null, "u", valid)).toEqual([]);
    expect(loadRecent(memory(), "", valid)).toEqual([]);
    expect(() => saveRecent(null, "u", ["a"])).not.toThrow();
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(loadRecent(broken, "u", valid)).toEqual([]);
    expect(() => saveRecent(broken, "u", ["a"])).not.toThrow();
  });
});
