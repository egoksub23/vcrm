import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { INCIDENT_FLAGS } from "@/lib/incidents/constants";
import { RECIPES } from "./rules";

// Every message key the incident platform screens ask for must exist in the English file, so a typo shows up here and not as a raw key path on screen.
// Static keys are read out of the source (`t("a.b")` with `t` from `useTranslations("Namespace")`); the keys built at run time are listed below.

type Json = { [k: string]: Json | string };
const en = JSON.parse(readFileSync(join(process.cwd(), "messages", "en.json"), "utf8")) as Json;

const get = (path: string): unknown => path.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Json)[k] : undefined), en);

const FILES = [
  "src/components/incidents/setup/roles-screen.tsx",
  "src/components/incidents/setup/rules-screen.tsx",
  "src/components/incidents/setup/setup-guide.tsx",
  "src/components/incidents/overview-screen.tsx",
  "src/components/incidents/tasks-screen.tsx",
  "src/components/incidents/message-log-panel.tsx",
  "src/components/incidents/report/report-app.tsx",
  "src/components/incidents/setup/portal-screen.tsx",
  "src/components/incidents/setup/rule-editor.tsx",
  "src/components/incidents/setup/workflow-panel.tsx",
  "src/components/incidents/approvals-panel.tsx",
  "src/components/incidents/registers-screen.tsx",
  "src/components/incidents/setup/form-builder.tsx",
  "src/components/incidents/setup/pack-screen.tsx",
  "src/components/incidents/reports-screen.tsx",
  "src/components/incidents/record-view.tsx",
  "src/components/incidents/setup/retention-panel.tsx",
  "src/components/incidents/clearances-screen.tsx",
  "src/components/incidents/clearance-panel.tsx",
  "src/app/(dashboard)/incidents/setup/page.tsx",
  "src/app/(dashboard)/incidents/setup/roles/page.tsx",
  "src/app/(dashboard)/incidents/setup/rules/page.tsx",
];

function staticKeys(file: string): { path: string; where: string }[] {
  const src = readFileSync(join(process.cwd(), file), "utf8");
  const out: { path: string; where: string }[] = [];
  for (const m of src.matchAll(/const (\w+) = useTranslations\("([^"]+)"\)/g)) {
    const [, name, ns] = m;
    for (const call of src.matchAll(new RegExp(`\\b${name}\\("([A-Za-z0-9_.]+)"`, "g"))) out.push({ path: `${ns}.${call[1]}`, where: file });
  }
  return out;
}

describe("incident platform strings", () => {
  for (const file of FILES) {
    it(`${file} only asks for keys that exist`, () => {
      const keys = staticKeys(file);
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) expect(typeof get(k.path), `${k.path} (${k.where})`).toBe("string");
    });
  }

  it("has the keys built at run time", () => {
    const paths = [
      ...["roles", "people"].map((k) => `IncidentPlatform.roles.tab.${k}`),
      ...["staff", "outside"].map((k) => `IncidentPlatform.roles.form.${k}`),
      ...["no_members", "everyone_away", "no_address", "no_people_on_incident"].map((k) => `IncidentPlatform.warnings.${k}`),
      ...INCIDENT_FLAGS.map((f) => `IncidentPlatform.flagNoun.${f}`),
      ...["template", "roles", "rules", "packs", "portal"].flatMap((s) => ["title", "help", "doneFact", "todoFact"].map((k) => `IncidentPlatform.guide.steps.${s}.${k}`)),
      ...["unacknowledged", "overdue", "serious"].map((k) => `IncidentPlatform.overview.needs.${k}`),
      ...["raised", "unacknowledged", "step_overdue", "unresolved", "closed"].map((k) => `IncidentPlatform.rules.editor.trigger.${k}`),
      ...["minutes", "hours", "days"].map((k) => `IncidentPlatform.rules.editor.unit.${k}`),
      ...["injury", "concussion", "illness", "other"].map((k) => `IncidentPlatform.clearances.type_${k}`),
      ...["export", "purge", "auto_purge"].map((k) => `IncidentPlatform.retention.log.${k}`),
      ...["queued", "sending", "sent", "acknowledged", "failed", "skipped"].map((k) => `IncidentPlatform.log.status.${k}`),
      ...["raised", "reminder", "escalated", "step_overdue", "closed", "approval", "test"].map((k) => `IncidentPlatform.log.reason.${k}`),
      ...["all", "injury", "breach", "near_miss", "property", "safeguarding"].map((k) => `IncidentPlatform.registers.names.${k}`),
      ...["involved", "choice", "text", "longtext", "yesno", "photo"].map((k) => `IncidentPlatform.builder.type.${k}`),
      ...["minor", "first_aid", "cannot_continue", "hospital"].map((k) => `IncidentPlatform.builder.band.${k}`),
      ...["published", "archived", "draft"].map((k) => `IncidentPlatform.builder.status.${k}`),
      ...["approved", "rejected"].map((k) => `IncidentPlatform.approvals.decision.${k}`),
    ];
    for (const p of paths) expect(typeof get(p), p).toBe("string");
  });

  it("uses the plain words for the things the screens call by name", () => {
    expect(get("Incidents.detail.obligations.title")).toBe("Required steps");
    expect(get("Settings.incidents.standards.frameworksHeading")).toBe("Compliance packs");
    expect(get("IncidentPlatform.guide.title")).toBe("Setup guide");
  });

  it("every recipe is described in plain words with a name and a reason", () => {
    for (const r of RECIPES) {
      expect(r.name.length, r.key).toBeGreaterThan(10);
      expect(r.description.length, r.key).toBeGreaterThan(20);
    }
  });
});

describe("the coach report in Malay and Chinese", () => {
  const leaves = (node: unknown, prefix = ""): string[] =>
    typeof node === "object" && node !== null ? Object.entries(node as Json).flatMap(([k, v]) => leaves(v, `${prefix}${prefix ? "." : ""}${k}`)) : [prefix];
  const load = (lang: string) => JSON.parse(readFileSync(join(process.cwd(), "messages", `${lang}.json`), "utf8")) as Json;

  for (const lang of ["ms", "zh"]) {
    it(`${lang} has every word of the page`, () => {
      const m = load(lang);
      const expected = leaves((en as Json & { IncidentPlatform: { report: Json } }).IncidentPlatform.report);
      const at = (path: string) => path.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Json)[k] : undefined), (m as Json & { IncidentPlatform: { report: Json } }).IncidentPlatform.report);
      for (const p of expected) expect(typeof at(p), `${lang}: ${p}`).toBe("string");
    });
    it(`${lang} keeps the placeholders of the English text`, () => {
      const m = load(lang) as Json & { IncidentPlatform: { report: Json } };
      const pick = (root: Json, path: string) => path.split(".").reduce<unknown>((n, k) => (n as Json)[k], root) as string;
      for (const p of leaves((en as Json & { IncidentPlatform: { report: Json } }).IncidentPlatform.report)) {
        const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
        expect(holes(pick(m.IncidentPlatform.report, p)), `${lang}: ${p}`).toBe(holes(pick((en as Json & { IncidentPlatform: { report: Json } }).IncidentPlatform.report, p)));
      }
    });
  }

  it("labels every word of the built-in form in all three languages", async () => {
    const { CCA_FORM } = await import("@/lib/incidents/intake/form-schema");
    const maps = CCA_FORM.steps.flatMap((s) => [s.title, ...s.fields.flatMap((f) => [f.label, ...(f.help ? [f.help] : []), ...(f.options ?? []).flatMap((o) => [o.label, ...(o.help ? [o.help] : [])])])]);
    for (const m of maps) {
      expect(Object.keys(m).sort(), m.en).toEqual(["en", "ms", "zh"]);
    }
  });
});
