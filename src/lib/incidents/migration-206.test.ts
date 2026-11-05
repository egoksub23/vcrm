import { describe, expect, it } from "vitest";
import { readMigration } from "@/lib/testing/read-migration";
import {
  ESCALATION_DEFAULT_MINUTES,
  INCIDENT_FLAGS,
  escalationDefaultsFor,
  isIncidentFlag,
  severityRank,
} from "./constants";

// Static shape test for migration 206 (incident templates + frameworks). The SQL
// is not run in CI, so this pins what the app relies on: the kind column, the
// one-active-template trigger, the dropped BNM-only CHECKs, the catalogue
// validation, the obligation tables, and every seeded category / rule.

const sql = readMigration("206_incident_templates.sql");
const school = sql.slice(sql.indexOf("SEED: School Incident Management"), sql.indexOf("SEED: frameworks"));
const rules = sql.slice(sql.indexOf("SEED: frameworks"));

describe("migration 206: templates and frameworks", () => {
  it("adds a kind column limited to template / framework", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'template'/);
    expect(sql).toContain("CHECK (kind IN ('template', 'framework'))");
  });

  it("turns ISO 27035 and PDPA into frameworks and keeps every account on a template", () => {
    expect(sql).toMatch(/SET kind = 'framework'\s+WHERE slug IN \('iso_27035', 'pdpa_my'\)/);
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("ON CONFLICT (account_id, standard_id) DO UPDATE SET is_active = true");
  });

  it("allows one active template per account but any number of frameworks", () => {
    expect(sql).toContain("enforce_single_active_incident_template");
    expect(sql).toMatch(/s\.kind = 'template'/);
    expect(sql).toContain("AFTER INSERT OR UPDATE OF is_active, standard_id ON public.account_incident_standards");
  });
});

describe("migration 206: the BNM-only CHECK constraints", () => {
  it("drops the type and severity CHECKs on incidents and the severity CHECK on escalation policies, found by column", () => {
    expect(sql).toContain("con.conrelid = 'public.incidents'::regclass AND a.attname IN ('incident_type', 'severity')");
    expect(sql).toContain("con.conrelid = 'public.incident_escalation_policies'::regclass AND a.attname = 'severity'");
    expect(sql).toContain("DROP CONSTRAINT %I");
  });

  it("validates type and severity against the incident's own template instead", () => {
    expect(sql).toContain("validate_incident_catalogue");
    expect(sql).toContain("BEFORE INSERT OR UPDATE OF incident_type, severity, standard_id ON public.incidents");
    expect(sql).toMatch(/IF NEW\.standard_id IS NULL THEN\s+RETURN NEW;/);
  });

  it("widens the notification parties without dropping any", () => {
    for (const p of ["bnm", "pdp_commissioner", "mycert", "parent_guardian", "school_leadership", "ministry_education", "insurer"]) {
      expect(sql, p).toContain(`'${p}'`);
    }
  });

  it("keeps P1-P4 escalation timers and maps critical/high/medium/low onto them", () => {
    expect(sql).toContain("p_severity IN ('P1', 'critical')");
    expect(sql).toContain("WHEN p_severity IN ('P1', 'critical') THEN CASE WHEN p_level = 1 THEN 15 ELSE 60 END");
    expect(sql).toContain("WHEN p_severity IN ('P2', 'high')     THEN CASE WHEN p_level = 1 THEN 60 ELSE 240 END");
    expect(sql).toContain("WHEN p_severity IN ('P3', 'medium')   THEN CASE WHEN p_level = 1 THEN 1440 ELSE 43200 END");
    expect(sql).toContain("WHEN p_severity IN ('P4', 'low')      THEN CASE WHEN p_level = 1 THEN 10080 ELSE 43200 END");
  });
});

describe("migration 206: obligations", () => {
  it("creates flags, default flags, rules and a per-incident checklist", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS incident_flags TEXT[] NOT NULL DEFAULT '{}'");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS default_flags TEXT[] NOT NULL DEFAULT '{}'");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.incident_obligation_rules");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.incident_obligations");
    expect(sql).toContain("UNIQUE (incident_id, rule_id)");
  });

  it("has RLS on both tables: rules readable by all, obligations only as visible as the incident, ticked off by incidents.manage", () => {
    expect(sql).toContain("ALTER TABLE public.incident_obligation_rules ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE public.incident_obligations ENABLE ROW LEVEL SECURITY");
    expect(sql).toMatch(/incident_obligations_update[\s\S]*has_capability\(account_id, 'incidents\.manage'\)/);
    expect(sql).not.toMatch(/CREATE POLICY incident_obligations_(insert|delete)/);
  });

  it("builds the checklist from ACTIVE frameworks only, on insert and when flags change", () => {
    expect(sql).toContain("s.kind = 'framework'");
    expect(sql).toContain("ais.is_active");
    expect(sql).toContain("AFTER INSERT OR UPDATE OF incident_flags, detected_at ON public.incidents");
    // never block raising an incident
    expect(sql).toMatch(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'Failed to sync obligations/);
  });

  it("is not callable from a browser role", () => {
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.incident_sync_obligations(UUID) FROM PUBLIC, anon, authenticated");
  });
});

describe("migration 206: School Incident Management template", () => {
  it("is a template with the four-level scale", () => {
    expect(school).toContain("'school_incident'");
    expect(school).toContain("'template'");
    for (const slug of ["critical", "high", "medium", "low"]) expect(school, slug).toContain(`'${slug}'`);
  });

  it("seeds every school category", () => {
    for (const code of ["CCA", "INJ", "NMS", "PRD", "THF", "SEC", "CYB", "DBR", "SGD", "FIR", "VEN", "OTH"]) {
      expect(school, code).toContain(`('${code}',`);
    }
  });

  it("flags the categories that frameworks care about", () => {
    expect(school).toMatch(/'CCA'[\s\S]*?'\{injury,child_involved\}'/);
    expect(school).toMatch(/'DBR'[\s\S]*?'\{personal_data,infosec\}'/);
    expect(school).toMatch(/'SGD'[\s\S]*?'\{child_involved,safeguarding\}'/);
  });

  it("only uses flags the app knows", () => {
    const used = new Set<string>();
    for (const m of sql.matchAll(/'\{([a-z_,]+)\}'/g)) for (const f of m[1].split(",")) used.add(f);
    for (const m of sql.matchAll(/,\s*\n\s*'([a-z_]+)', (?:\d+|NULL), (?:'[a-z_]+'|NULL), \d+\)/g)) used.add(m[1]);
    for (const f of used) expect(isIncidentFlag(f), f).toBe(true);
  });
});

describe("migration 206: framework rules", () => {
  it("adds the two new frameworks", () => {
    expect(rules).toContain("'iso_45001'");
    expect(rules).toContain("'school_policy'");
    expect(rules.match(/'framework'/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("gives PDPA an assessment, a Commissioner notice at 72 hours and a data-subject notice", () => {
    expect(rules).toMatch(/'pdpa_my', 'PDPA_COMMISSIONER'[\s\S]*?'personal_data', 72, 'pdp_commissioner'/);
    expect(rules).toContain("'PDPA_ASSESS'");
    expect(rules).toContain("'PDPA_SUBJECTS'");
  });

  it("gives ISO 27035 its phases and ISO 45001 its injury steps", () => {
    for (const code of ["ISO27035_ASSESS", "ISO27035_EVIDENCE", "ISO27035_RESPOND", "ISO27035_LESSONS"]) expect(rules, code).toContain(`'${code}'`);
    for (const code of ["ISO45001_AID", "ISO45001_NEXTKIN", "ISO45001_INVESTIGATE", "ISO45001_CORRECTIVE", "ISO45001_VERIFY"]) expect(rules, code).toContain(`'${code}'`);
  });

  it("marks the school rules as starters to be replaced", () => {
    expect(rules).toContain("Starter rule");
  });

  it("is idempotent", () => {
    expect(rules).toContain("ON CONFLICT (standard_id, code) DO NOTHING");
  });
});

describe("incident constants used by templates", () => {
  it("ranks both severity scales onto the same four tiers", () => {
    expect(["P1", "P2", "P3", "P4"].map(severityRank)).toEqual([0, 1, 2, 3]);
    expect(["critical", "high", "medium", "low"].map(severityRank)).toEqual([0, 1, 2, 3]);
    expect(severityRank("something-else")).toBe(4);
  });

  it("gives critical/high/medium/low the timers of P1-P4 and leaves P1-P4 alone", () => {
    expect(escalationDefaultsFor("critical")).toEqual(ESCALATION_DEFAULT_MINUTES.P1);
    expect(escalationDefaultsFor("high")).toEqual(ESCALATION_DEFAULT_MINUTES.P2);
    expect(escalationDefaultsFor("medium")).toEqual(ESCALATION_DEFAULT_MINUTES.P3);
    expect(escalationDefaultsFor("low")).toEqual(ESCALATION_DEFAULT_MINUTES.P4);
    expect(escalationDefaultsFor("P2")).toEqual({ level1: 60, level2: 240 });
    expect(escalationDefaultsFor("unknown")).toEqual({ level1: 1440, level2: 43200 });
  });

  it("recognises exactly the flag vocabulary", () => {
    for (const f of INCIDENT_FLAGS) expect(isIncidentFlag(f)).toBe(true);
    expect(isIncidentFlag("bogus")).toBe(false);
    expect(isIncidentFlag(7)).toBe(false);
  });
});
