import { describe, expect, it } from "vitest";
import { readMigration } from "@/lib/testing/read-migration";

// Static shape test for migration 197 (ISO 27035 + PDPA MY seed data).
// Pins the slugs, codes, and severity levels so a future edit that silently
// drops or renames a code fails in CI rather than in the raise-incident dialog.

const sql = readMigration("197_incident_standards_phase3.sql");

describe("migration 197: ISO 27035 standard", () => {
  it("inserts the standard with the correct slug", () => {
    expect(sql).toContain("'iso_27035'");
    expect(sql).toContain("ISO/IEC 27035");
    expect(sql).toContain("ISO/IEC");
  });

  it("seeds all 10 incident type codes", () => {
    for (const code of ["MAL", "UAC", "INF", "INT", "DOS", "SCA", "PHI", "PHY", "SUP", "INU"]) {
      expect(sql, `code ${code}`).toContain(`'${code}'`);
    }
  });

  it("seeds 4 severity levels with expected slugs", () => {
    const iso = sql.slice(sql.indexOf("'iso_27035'"), sql.indexOf("'pdpa_my'"));
    for (const slug of ["critical", "high", "medium", "low"]) {
      expect(iso, `slug ${slug}`).toContain(`'${slug}'`);
    }
  });

  it("marks high-risk types as notifiable", () => {
    const iso = sql.slice(sql.indexOf("'iso_27035'"), sql.indexOf("'pdpa_my'"));
    // MAL, UAC, INF, DOS, PHI, SUP are notifiable (true in position 6 of their VALUES row)
    const notifiableCount = (iso.match(/true, \d+\)/g) ?? []).length;
    expect(notifiableCount).toBeGreaterThanOrEqual(6);
  });

  it("is scoped by WHERE s.slug = 'iso_27035'", () => {
    const iso = sql.slice(sql.indexOf("'iso_27035'"), sql.indexOf("'pdpa_my'"));
    expect(iso.match(/WHERE s\.slug = 'iso_27035'/g)?.length).toBe(2);
  });
});

describe("migration 197: PDPA Malaysia standard", () => {
  it("inserts the standard with the correct slug", () => {
    const pdpa = sql.slice(sql.indexOf("'pdpa_my'"));
    expect(pdpa).toContain("'pdpa_my'");
    expect(pdpa).toContain("Personal Data Protection Act");
    expect(pdpa).toContain("Personal Data Protection Commissioner");
  });

  it("seeds all 8 incident type codes", () => {
    const pdpa = sql.slice(sql.indexOf("'pdpa_my'"));
    for (const code of ["PDB", "UDC", "DLD", "ACC", "ULP", "CBT", "DSR", "SEC"]) {
      expect(pdpa, `code ${code}`).toContain(`'${code}'`);
    }
  });

  it("seeds 4 severity levels including the PDPC notification threshold level", () => {
    const pdpa = sql.slice(sql.indexOf("'pdpa_my'"));
    for (const slug of ["critical", "significant", "limited", "minor"]) {
      expect(pdpa, `slug ${slug}`).toContain(`'${slug}'`);
    }
    expect(pdpa).toContain("notify PDPC");
  });

  it("is scoped by WHERE s.slug = 'pdpa_my'", () => {
    const pdpa = sql.slice(sql.indexOf("'pdpa_my'"));
    expect(pdpa.match(/WHERE s\.slug = 'pdpa_my'/g)?.length).toBe(2);
  });
});

describe("migration 197: overall structure", () => {
  it("contains exactly two standards", () => {
    const matches = sql.match(/INSERT INTO public\.incident_standards/g);
    expect(matches?.length).toBe(2);
  });

  it("does not create any tables or alter existing schema", () => {
    expect(sql).not.toContain("CREATE TABLE");
    expect(sql).not.toContain("ALTER TABLE");
    expect(sql).not.toContain("CREATE INDEX");
    expect(sql).not.toContain("CREATE POLICY");
  });

  it("does not seed account_incident_standards (accounts opt in via Settings)", () => {
    expect(sql).not.toContain("account_incident_standards");
  });
});
