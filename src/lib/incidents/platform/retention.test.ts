import { describe, expect, it } from "vitest";

import { buildExport, cutoffForYears, parseCutoff, parseRetentionYears, purgePhrase } from "./retention";

const NOW = new Date("2026-11-11T10:00:00Z");

describe("retention", () => {
  it("keeps everything until the school deletes it when no period is set", () => {
    expect(parseRetentionYears(null)).toEqual({ ok: true, value: null });
    expect(parseRetentionYears("")).toEqual({ ok: true, value: null });
  });
  it("accepts whole years from 1 to 50 and says what is wrong otherwise", () => {
    expect(parseRetentionYears(7)).toEqual({ ok: true, value: 7 });
    expect(parseRetentionYears("10")).toEqual({ ok: true, value: 10 });
    for (const bad of [0, 51, 2.5, "abc", -3]) expect(parseRetentionYears(bad)).toMatchObject({ ok: false });
  });
  it("works out the cutoff for a period", () => {
    expect(cutoffForYears(7, NOW)).toBe("2019-11-11");
    expect(cutoffForYears(1, NOW)).toBe("2025-11-11");
  });
  it("only accepts a cutoff that is a real date before today", () => {
    expect(parseCutoff("2024-12-31", NOW)).toEqual({ ok: true, value: "2024-12-31" });
    expect(parseCutoff("2026-11-10", NOW)).toEqual({ ok: true, value: "2026-11-10" });
    for (const bad of ["2026-11-11", "2027-01-01", "11/11/2024", "2024-13-45", 5, null]) expect(parseCutoff(bad, NOW)).toMatchObject({ ok: false });
  });
  it("asks the person to type the number being deleted", () => {
    expect(purgePhrase(12)).toBe("DELETE 12");
  });
  it("builds an export with a warning about what it contains", () => {
    const bundle = buildExport({ now: NOW, cutoff: "2024-12-31", incidents: [{ id: "i1" }] });
    expect(bundle).toMatchObject({ exported_at: NOW.toISOString(), cutoff: "2024-12-31", incidents: [{ id: "i1" }] });
    expect(bundle.note).toMatch(/children's names/);
  });
});
