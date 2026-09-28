import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { INCIDENT_STATUSES } from "./constants";

// The incident detail screen reads Incidents.detail.activity.* keyed by
// event_type and Incidents.detail.notificationsSent.party.* keyed by
// recipient_party (en + ko, the two actively-maintained locales — see
// src/lib/audit/i18n.test.ts). Neither key set is exercised by the render
// smoke tests (incidents-render.test.tsx), since IncidentDetail's own data
// never loads under renderToStaticMarkup (effects don't run) — this is a
// static check instead, so a missing key renders as a raw key path rather
// than being caught only when someone actually opens the app.

type Json = { [k: string]: Json | string };

const load = (lang: string): Json =>
  JSON.parse(readFileSync(join(process.cwd(), "messages", `${lang}.json`), "utf8")) as Json;

const messages: Record<string, Json> = { en: load("en"), ko: load("ko") };

function at(root: Json, path: string): Json {
  return path.split(".").reduce<Json>((n, k) => n[k] as Json, root);
}

const ACTIVITY_EVENT_TYPES = [
  "created",
  "statusChanged",
  "severityChanged",
  "typeChanged",
  "leadChanged",
  "escalatedEvent",
  "closedEvent",
];

const RECIPIENT_PARTIES = ["bnm", "sponsor_emi", "partner", "pdp_commissioner", "data_subjects", "police", "other"];

describe.each(["en", "ko"])("incident strings (%s)", (lang) => {
  const m = messages[lang];

  it("names every incident status", () => {
    const status = at(m, "Incidents.common.status");
    for (const s of INCIDENT_STATUSES) expect(status[s], s).toBeTypeOf("string");
  });

  it("has every activity event-type sentence", () => {
    const activity = at(m, "Incidents.detail.activity");
    for (const key of ACTIVITY_EVENT_TYPES) expect(activity[key], key).toBeTypeOf("string");
  });

  it("names every external-notification recipient party", () => {
    const party = at(m, "Incidents.detail.notificationsSent.party");
    for (const p of RECIPIENT_PARTIES) expect(party[p], p).toBeTypeOf("string");
  });

  it("registers the two capabilities and the menu entry", () => {
    expect(at(m, "Permissions.cap.incidents_raise").label).toBeTypeOf("string");
    expect(at(m, "Permissions.cap.incidents_raise").description).toBeTypeOf("string");
    expect(at(m, "Permissions.cap.incidents_manage").label).toBeTypeOf("string");
    expect(at(m, "Permissions.cap.incidents_manage").description).toBeTypeOf("string");
    expect(at(m, "Permissions.cap.menu_incidents").label).toBeTypeOf("string");
    expect(at(m, "Sidebar").incidents).toBeTypeOf("string");
  });
});

describe("en and ko carry the same Incidents keys", () => {
  function leafPaths(node: Json | string, prefix = ""): string[] {
    if (typeof node === "string") return [prefix];
    return Object.entries(node).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
  }
  it("Incidents", () => {
    const en = leafPaths(at(messages.en, "Incidents")).sort();
    const ko = leafPaths(at(messages.ko, "Incidents")).sort();
    expect(ko).toEqual(en);
  });
});
