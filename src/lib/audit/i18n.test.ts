import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS, AUDIT_ACTOR_KINDS, AUDIT_ENTITY_TYPES } from "./types";

// The audit screens read Audit.* and Settings.audit.* (en + ko only).
// A missing key renders as a raw key path in the UI, so both languages
// must carry every key the code can ask for, and they must agree.

type Json = { [k: string]: Json | string };

const load = (lang: string): Json =>
  JSON.parse(readFileSync(join(process.cwd(), "messages", `${lang}.json`), "utf8")) as Json;

const messages: Record<string, Json> = { en: load("en"), ko: load("ko") };

function leafPaths(node: Json | string, prefix = ""): string[] {
  if (typeof node === "string") return [prefix];
  return Object.entries(node).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}

function at(root: Json, path: string): Json {
  return path.split(".").reduce<Json>((n, k) => n[k] as Json, root);
}

describe.each(["en", "ko"])("audit strings (%s)", (lang) => {
  const m = messages[lang];

  it("names every action, actor kind and item type", () => {
    const audit = at(m, "Audit");
    for (const a of AUDIT_ACTIONS) expect(at(audit, "actions")[a], a).toBeTypeOf("string");
    for (const k of AUDIT_ACTOR_KINDS.filter((k) => k !== "user")) {
      expect(at(audit, "actorKinds")[k], k).toBeTypeOf("string");
    }
    for (const e of AUDIT_ENTITY_TYPES) expect(at(audit, "entities")[e], e).toBeTypeOf("string");
    for (const r of ["owner", "admin", "agent", "viewer"]) {
      expect(at(audit, "roleNames")[r], r).toBeTypeOf("string");
    }
  });

  it("has the summary sentences the screen renders", () => {
    const summary = at(m, "Audit.summary");
    for (const key of [
      "renamed",
      "changed",
      "edited",
      "published",
      "language",
      "tagApplied",
      "roleChange",
      "capabilityOn",
      "capabilityOff",
      "invitedRole",
      "person",
      "untagged",
      "left",
    ]) {
      expect(summary[key], key).toBeTypeOf("string");
    }
  });

  it("registers the capability, the settings section and the panel", () => {
    expect(at(m, "Permissions.cap.audit_view").label).toBeTypeOf("string");
    expect(at(m, "Permissions.cap.audit_view").description).toBeTypeOf("string");
    expect(at(m, "Settings.sections").audit).toBeTypeOf("string");
    const panel = at(m, "Settings.audit");
    for (const key of ["title", "description", "export", "loadMore", "empty", "emptyFiltered", "loadFailed"]) {
      expect(panel[key], key).toBeTypeOf("string");
    }
    const filters = at(m, "Settings.audit.filters");
    for (const key of ["range_24h", "range_7d", "range_30d", "range_all", "range_custom"]) {
      expect(filters[key], key).toBeTypeOf("string");
    }
  });
});

describe("en and ko carry the same audit keys", () => {
  for (const ns of ["Audit", "Settings.audit"]) {
    it(ns, () => {
      const en = leafPaths(at(messages.en, ns)).sort();
      const ko = leafPaths(at(messages.ko, ns)).sort();
      expect(ko).toEqual(en);
    });
  }
});
