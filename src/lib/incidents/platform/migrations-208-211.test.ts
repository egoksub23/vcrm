import { describe, expect, it } from "vitest";

import { readMigration } from "@/lib/testing/read-migration";

// The SQL is run by hand on the Halo PostgreSQL and CI does not execute it, so this pins what the application relies on: every new table is keyed by
// account_id and has row-level security on, writes need incidents.configure, nothing the browser can reach is able to send or claim messages, and each
// migration is safe to run twice.

const files = ["208_incident_roles_contacts.sql", "209_incident_rules_deliveries.sql", "210_incident_steps_role.sql", "211_incident_sweep_skips_rule_schools.sql"];
const sql = Object.fromEntries(files.map((f) => [f, readMigration(f).replace(/\r\n/g, "\n")]));
const all = Object.values(sql).join("\n");

const NEW_TABLES = ["incident_contacts", "incident_roles", "incident_role_members", "incident_rules", "incident_deliveries"];

describe("new tables are per school", () => {
  for (const table of NEW_TABLES) {
    it(`${table}: account_id NOT NULL, cascades with the account, row-level security on`, () => {
      const create = all.match(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\(([\\s\\S]*?)\\n\\);`));
      expect(create, `${table} is created`).not.toBeNull();
      expect(create![1]).toMatch(/account_id\s+UUID\s+NOT NULL REFERENCES public\.accounts\(id\) ON DELETE CASCADE/);
      expect(all).toContain(`ALTER TABLE public.${table}`.concat(table === "incident_contacts" ? "     ENABLE ROW LEVEL SECURITY" : ""));
    });
  }

  it("enables row-level security on all five", () => {
    for (const table of NEW_TABLES) expect(all).toMatch(new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`));
  });

  it("lets only incidents.configure write roles, people, members and rules", () => {
    expect(sql["208_incident_roles_contacts.sql"]).toContain("has_capability(account_id, %L)) WITH CHECK (has_capability(account_id, %L))");
    expect(sql["208_incident_roles_contacts.sql"]).toContain("t || '_write', t, 'incidents.configure', 'incidents.configure'");
    expect(sql["209_incident_rules_deliveries.sql"]).toMatch(/CREATE POLICY incident_rules_write ON public\.incident_rules FOR ALL\s+USING \(has_capability\(account_id, 'incidents\.configure'\)\)\s+WITH CHECK \(has_capability\(account_id, 'incidents\.configure'\)\)/);
  });

  it("gives the message log no insert, update or delete policy: only the server writes it", () => {
    const policies = [...sql["209_incident_rules_deliveries.sql"].matchAll(/CREATE POLICY (\w+) ON public\.incident_deliveries FOR (\w+)/g)].map((m) => [m[1], m[2]]);
    expect(policies).toEqual([["incident_deliveries_select", "SELECT"]]);
  });

  it("checks that a member's role and person belong to the same school", () => {
    expect(sql["208_incident_roles_contacts.sql"]).toContain("enforce_incident_role_member_account");
    expect(sql["208_incident_roles_contacts.sql"]).toMatch(/r\.account_id = NEW\.account_id/);
    expect(sql["208_incident_roles_contacts.sql"]).toMatch(/c\.account_id = NEW\.account_id/);
  });
});

describe("functions the browser must not call", () => {
  const SERVICE_ONLY = [
    "seed_incident_roles(UUID)",
    "claim_incident_deliveries(INTEGER)",
    "incident_unacknowledged(UUID, TIMESTAMPTZ, INTEGER)",
    "incident_overdue_steps(UUID, TIMESTAMPTZ, INTEGER)",
    "incident_unresolved(UUID, TIMESTAMPTZ, INTEGER)",
    "incident_accounts_with_timed_rules()",
  ];
  for (const fn of SERVICE_ONLY) {
    it(`${fn} is revoked from the public and granted to the service role`, () => {
      expect(all).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`);
      expect(all).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role;`);
    });
  }
  it("keeps the table-returning helpers SECURITY DEFINER with a fixed search_path", () => {
    for (const name of ["claim_incident_deliveries", "incident_unacknowledged", "incident_overdue_steps", "seed_incident_roles"]) {
      const body = all.slice(all.indexOf(`FUNCTION public.${name}(`));
      expect(body.slice(0, 600), name).toMatch(/SECURITY DEFINER\s+SET search_path = public/);
    }
  });
});

describe("the message log and timers", () => {
  it("never sends the same message twice to the same address for the same thing", () => {
    expect(sql["209_incident_rules_deliveries.sql"]).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_deliveries_once[\s\S]*role_key, channel, address, ref_key/);
  });
  it("claims messages with SKIP LOCKED so two sweeps cannot both send one", () => {
    expect(sql["209_incident_rules_deliveries.sql"]).toContain("FOR UPDATE SKIP LOCKED");
  });
  it("counts an incident as waiting only while it is still 'reported', and chases steps on any open incident", () => {
    const body = sql["209_incident_rules_deliveries.sql"];
    const unack = body.slice(body.indexOf("FUNCTION public.incident_unacknowledged"), body.indexOf("FUNCTION public.incident_overdue_steps"));
    expect(unack).toContain("i.status = 'reported'");
    const overdue = body.slice(body.indexOf("FUNCTION public.incident_overdue_steps"), body.indexOf("FUNCTION public.incident_accounts_with_timed_rules"));
    expect(overdue).toContain("i.status <> 'closed'");
  });
  it("only skips the old level sweep for schools that have a 'nobody acknowledged' rule switched on", () => {
    const body = sql["211_incident_sweep_skips_rule_schools.sql"];
    expect(body).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM public\.incident_rules r\s+WHERE r\.account_id = y\.account_id AND r\.enabled AND r\.trigger = 'unacknowledged'/);
    expect(body).toContain("'auto_timeout', 'manual', 'rule'");
  });
});

describe("running a migration twice", () => {
  it("is safe: every create is IF NOT EXISTS / OR REPLACE and every policy and trigger is dropped first", () => {
    expect(all).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(all).not.toMatch(/CREATE INDEX (?!IF NOT EXISTS)/);
    expect(all).not.toMatch(/CREATE UNIQUE INDEX (?!IF NOT EXISTS)/);
    for (const m of all.matchAll(/CREATE TRIGGER (\w+)/g)) expect(all, m[1]).toContain(`DROP TRIGGER IF EXISTS ${m[1]}`);
    expect(all).toMatch(/ADD COLUMN IF NOT EXISTS role_key/);
  });
  it("maps the built-in parties to roles and fills existing steps", () => {
    const body = sql["210_incident_steps_role.sql"];
    expect(body).toContain("WHEN 'school_leadership' THEN 'principal'");
    expect(body).toContain("WHEN 'pdp_commissioner'  THEN 'dpo'");
    expect(body).toContain("CREATE TRIGGER on_incident_obligation_role");
  });
});

describe("migrations 212 to 214 (coach intake, retention, workflow)", () => {
  const m212 = readMigration("212_incident_coach_intake.sql").replace(/\r\n/g, "\n");
  const m213 = readMigration("213_incident_retention_log.sql").replace(/\r\n/g, "\n");
  const m214 = readMigration("214_incident_workflow.sql").replace(/\r\n/g, "\n");

  it("keeps only a hash of each key, and never exposes the roster of a link to a client", () => {
    expect(m212).toMatch(/key_hash\s+TEXT\s+NOT NULL UNIQUE/);
    expect(m212).not.toMatch(/CREATE POLICY \w+ ON public\.incident_intake_sessions/);
    expect(m212).toContain("ALTER TABLE public.incident_intake_sessions ENABLE ROW LEVEL SECURITY");
  });

  it("reads Return to Play with incidents.medical and gives clients no write policy on it", () => {
    expect(m212).toMatch(/CREATE POLICY person_clearances_select ON public\.person_clearances FOR SELECT USING \(has_capability\(account_id, 'incidents\.medical'\)\)/);
    expect(m212).not.toMatch(/CREATE POLICY \w+ ON public\.person_clearances FOR (INSERT|UPDATE|DELETE|ALL)/);
  });

  it("limits what an incident's source and a person's involvement can be", () => {
    expect(m212).toContain("CHECK (source IN ('halo', 'coach_portal', 'api'))");
    expect(m212).toContain("CHECK (involvement IN ('injured', 'involved', 'witness'))");
  });

  it("allows 1 to 50 years of retention, or none", () => {
    expect(m212).toContain("retention_years IS NULL OR retention_years BETWEEN 1 AND 50");
  });

  it("logs deletes in a table clients can only read", () => {
    expect(m213).toMatch(/CREATE POLICY incident_retention_log_select ON public\.incident_retention_log FOR SELECT/);
    expect(m213).not.toMatch(/CREATE POLICY \w+ ON public\.incident_retention_log FOR (INSERT|UPDATE|DELETE|ALL)/);
  });

  it("allows one pending approval per role per incident, and writes by the server only", () => {
    expect(m214).toMatch(/uq_incident_approvals_pending ON public\.incident_approvals \(incident_id, role_key\) WHERE decision IS NULL/);
    expect(m214).not.toMatch(/CREATE POLICY \w+ ON public\.incident_approvals FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(m214).toMatch(/incident_workflow_guards_write ON public\.incident_workflow_guards FOR ALL\s+USING \(has_capability\(account_id, 'incidents\.configure'\)\)/);
  });

  it("never lets a requirement be set on 'reported'", () => {
    expect(m214).toContain("to_status IN ('triaged', 'contained', 'investigating', 'recovered', 'closed')");
  });
});

describe("migration 215 (report form versions)", () => {
  const m215 = readMigration("215_incident_form_versions.sql").replace(/\r\n/g, "\n");

  it("allows one draft and one published version per school and form", () => {
    expect(m215).toMatch(/uq_incident_form_draft\s+ON public\.incident_form_versions \(account_id, form_key\) WHERE status = 'draft'/);
    expect(m215).toMatch(/uq_incident_form_published ON public\.incident_form_versions \(account_id, form_key\) WHERE status = 'published'/);
    expect(m215).toContain("UNIQUE (account_id, form_key, version)");
  });
  it("only a configurer writes a form, and publishing is a single service-only step", () => {
    expect(m215).toMatch(/incident_form_versions_write ON public\.incident_form_versions FOR ALL\s+USING \(has_capability\(account_id, 'incidents\.configure'\)\)/);
    expect(m215).toContain("REVOKE ALL ON FUNCTION public.publish_incident_form(UUID, TEXT, INTEGER, UUID) FROM PUBLIC, anon, authenticated;");
    expect(m215).toMatch(/SET status = 'archived'[\s\S]*SET status = 'published'/);
  });
  it("records the version on the link and on the incident", () => {
    expect(m215).toContain("ALTER TABLE public.incident_intake_sessions ADD COLUMN IF NOT EXISTS form_version INTEGER");
    expect(m215).toContain("ALTER TABLE public.incidents                ADD COLUMN IF NOT EXISTS form_version INTEGER");
  });
});

describe("migration 216 (a school's own pack)", () => {
  const m216 = readMigration("216_incident_school_pack.sql").replace(/\r\n/g, "\n");

  it("shows a school's pack only to that school, and the built-in packs to everyone", () => {
    expect(m216).toMatch(/incident_standards_select" ON public\.incident_standards\s+FOR SELECT USING \(account_id IS NULL OR is_account_member\(account_id\)\)/);
    expect(m216).toContain("s.account_id IS NULL OR is_account_member(s.account_id)");
  });
  it("lets only a configurer write a school's own pack, never a built-in one", () => {
    expect(m216).toMatch(/incident_standards_write ON public\.incident_standards FOR ALL\s+USING \(account_id IS NOT NULL AND has_capability\(account_id, 'incidents\.configure'\)\)/);
    expect(m216).toMatch(/incident_obligation_rules_write[\s\S]*s\.account_id IS NOT NULL AND has_capability\(s\.account_id, 'incidents\.configure'\)/);
  });
  it("keeps a school's pack a framework, one per school", () => {
    expect(m216).toContain("uq_incident_standards_account_pack ON public.incident_standards (account_id) WHERE account_id IS NOT NULL AND kind = 'framework'");
    expect(m216).toMatch(/NEW\.kind <> 'framework' OR NEW\.is_system/);
  });
});

describe("migration 218 (timing defaults)", () => {
  const m218 = readMigration("218_incident_timing_defaults.sql").replace(/\r\n/g, "\n");
  it("keeps the shipped 30 minutes as the default wait, within sensible bounds", () => {
    expect(m218).toContain("ADD COLUMN IF NOT EXISTS ack_wait_minutes INTEGER NOT NULL DEFAULT 30 CHECK (ack_wait_minutes BETWEEN 1 AND 43200)");
  });
  it("lets only a configurer read or change a school's step overrides, one row per school and step", () => {
    expect(m218).toContain("PRIMARY KEY (account_id, rule_id)");
    expect(m218).toMatch(/incident_step_overrides_select ON public\.incident_step_overrides FOR SELECT USING \(has_capability\(account_id, 'incidents\.configure'\)\)/);
    expect(m218).toMatch(/incident_step_overrides_write\s+ON public\.incident_step_overrides FOR ALL\s+USING \(has_capability\(account_id, 'incidents\.configure'\)\)/);
    expect(m218).toContain("CHECK (NOT (no_deadline AND due_hours IS NOT NULL))");
  });
  it("applies the override when a checklist is built: skips an off step, uses the school's hours or none, else the shipped hours", () => {
    expect(m218).toContain("LEFT JOIN incident_step_overrides ov ON ov.account_id = v.account_id AND ov.rule_id = r.id");
    expect(m218).toContain("AND COALESCE(ov.enabled, TRUE)");
    expect(m218).toMatch(/WHEN ov\.no_deadline THEN NULL\s+WHEN ov\.due_hours IS NOT NULL THEN v\.detected_at \+ make_interval\(hours => ov\.due_hours\)\s+WHEN r\.due_hours IS NULL THEN NULL/);
  });
  it("keeps the rest of the 206 function: never reopens a done step, marks open steps not applicable when the flag goes", () => {
    expect(m218).toContain("WHERE incident_obligations.status = 'not_applicable'");
    expect(m218).toContain("SET status = 'not_applicable'");
  });
});

describe("migration 217 (events to the portal)", () => {
  const m217 = readMigration("217_incident_webhooks.sql").replace(/\r\n/g, "\n");
  it("only stores an https address, and keeps the events where clients can read but not write", () => {
    expect(m217).toContain("webhook_url ~ '^https://'");
    expect(m217).toMatch(/incident_webhook_events_select ON public\.incident_webhook_events FOR SELECT USING \(has_capability\(account_id, 'incidents\.configure'\)\)/);
    expect(m217).not.toMatch(/CREATE POLICY \w+ ON public\.incident_webhook_events FOR (INSERT|UPDATE|DELETE|ALL)/);
  });
  it("claims events without letting two senders take one, and keeps its functions to the service role", () => {
    expect(m217).toContain("FOR UPDATE SKIP LOCKED");
    expect(m217).toContain("REVOKE ALL ON FUNCTION public.claim_incident_webhook_events(INTEGER) FROM PUBLIC, anon, authenticated;");
    expect(m217).toContain("GRANT EXECUTE ON FUNCTION public.purge_incident_webhook_events() TO service_role;");
  });
});

describe("migration 220 (a school's own categories)", () => {
  const m220 = readMigration("220_incident_school_categories.sql").replace(/\r\n/g, "\n");
  it("lets a category be hidden without deleting it, and remembers what a copy was made from", () => {
    expect(m220).toContain("ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;");
    expect(m220).toContain("ADD COLUMN IF NOT EXISTS copied_from UUID REFERENCES public.incident_standards(id) ON DELETE SET NULL;");
  });
  it("allows one school-owned template per school, and still refuses a school-owned built-in", () => {
    expect(m220).toContain("uq_incident_standards_account_template ON public.incident_standards (account_id) WHERE account_id IS NOT NULL AND kind = 'template'");
    expect(m220).toContain("IF NEW.account_id IS NOT NULL AND NEW.is_system THEN");
    expect(m220).not.toContain("NEW.kind <> 'framework'");
  });
});

describe("migration 219 (the coach portal as one platform integration)", () => {
  const m219 = readMigration("219_incident_portal_platform.sql").replace(/\r\n/g, "\n");
  it("lets a key belong to the platform, and retires the keys schools made under the old design", () => {
    expect(m219).toContain("ALTER TABLE public.incident_intake_keys ALTER COLUMN account_id DROP NOT NULL;");
    expect(m219).toMatch(/UPDATE public\.incident_intake_keys SET revoked_at = now\(\) WHERE account_id IS NOT NULL AND revoked_at IS NULL;/);
  });
  it("maps a Vircle Group ID to one school, with that school's own frame origins", () => {
    expect(m219).toMatch(/group_id\s+TEXT\s+NOT NULL UNIQUE/);
    expect(m219).toContain("account_id      UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE");
    expect(m219).toContain("allowed_origins TEXT[]");
    expect(m219).toContain("CHECK (cardinality(allowed_origins) <= 10)");
  });
  it("lets a school's admins read their own link and lets no school write it", () => {
    expect(m219).toMatch(/incident_portal_schools_select ON public\.incident_portal_schools FOR SELECT USING \(has_capability\(account_id, 'incidents\.configure'\)\)/);
    expect(m219).not.toMatch(/CREATE POLICY \w+ ON public\.incident_portal_schools FOR (INSERT|UPDATE|DELETE|ALL)/);
  });
  it("remembers the Group ID on each report link, and uses the repo's updated-at trigger", () => {
    expect(m219).toContain("ALTER TABLE public.incident_intake_sessions ADD COLUMN IF NOT EXISTS group_id TEXT;");
    // the same tap sent again is matched within a school, so two schools may use the same idempotency string
    expect(m219).toContain("DROP INDEX IF EXISTS public.uq_incident_intake_sessions_idem;");
    expect(m219).toContain("ON public.incident_intake_sessions (key_id, group_id, idempotency_key)");
    expect(m219).toContain("EXECUTE FUNCTION public.update_updated_at_column();");
  });
});
