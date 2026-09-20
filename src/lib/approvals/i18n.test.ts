import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CAPABILITIES } from "@/lib/auth/capabilities";

import { DIFF_FIELDS } from "./rules";
import { APPROVAL_ERROR_CODES } from "./types";

// The approvals screens read Approvals.*, Settings.approvals.* and
// Permissions.cap.* (en + ko only). A missing key renders as a raw key path,
// so both languages must carry every key the code can ask for and agree.

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

function text(root: Json, path: string): string {
  return path.split(".").reduce<Json | string>((n, k) => (n as Json)[k], root) as string;
}

/** ICU placeholders ({name}, {count}) of a string. */
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();

describe.each(["en", "ko"])("approvals strings (%s)", (lang) => {
  const m = messages[lang];

  it("has a message for every error code", () => {
    const errors = at(m, "Approvals.errors");
    for (const code of APPROVAL_ERROR_CODES) expect(errors[code], code).toBeTypeOf("string");
  });

  it("names every chip, item type, action and diff field", () => {
    const a = at(m, "Approvals");
    for (const k of ["pending", "rejected", "pending_changes", "changes_rejected", "pendingTip", "pendingChangesTip", "rejectedTip", "rejectedNoNote"]) {
      expect(at(a, "chips")[k], k).toBeTypeOf("string");
    }
    for (const k of ["tag", "label", "both", "snippet", "article"]) expect(at(a, "types")[k], k).toBeTypeOf("string");
    for (const k of ["new", "edit"]) expect(at(a, "actions")[k], k).toBeTypeOf("string");
    for (const fields of Object.values(DIFF_FIELDS)) {
      for (const f of fields) expect(at(a, "fields")[f], f).toBeTypeOf("string");
    }
    for (const k of ["sentForApproval", "sendForApproval", "withdrawn", "dismissed", "review", "untitled", "unknownPerson"]) {
      expect(a[k], k).toBeTypeOf("string");
    }
  });

  it("has the Settings > Approvals panel, its toasts, dialogs and switches", () => {
    const p = at(m, "Settings.approvals");
    for (const key of ["title", "description", "loadFailed", "retry"]) expect(p[key], key).toBeTypeOf("string");
    for (const key of ["approve", "publish", "editApprove", "reject", "approveSelected", "selectAll"]) {
      expect(at(p, "actions")[key], key).toBeTypeOf("string");
    }
    for (const key of ["approved", "published", "rejected", "approvedMany", "approvedPartial"]) {
      expect(at(p, "toasts")[key], key).toBeTypeOf("string");
    }
    for (const key of ["title", "description", "noteLabel", "noteHint", "submit"]) {
      expect(at(p, "reject")[key], key).toBeTypeOf("string");
    }
    for (const key of ["title", "description", "submit"]) expect(at(p, "edit")[key], key).toBeTypeOf("string");
    const sw = at(p, "switches");
    for (const key of ["title", "needRoles", "savedOn", "savedOff"]) expect(sw[key], key).toBeTypeOf("string");
    for (const key of ["title", "intro", "one", "two", "three", "action"]) {
      expect(at(sw, "confirmOn")[key], key).toBeTypeOf("string");
    }
    for (const key of ["pending", "decided", "filtered"]) expect(at(p, "empty")[key], key).toBeTypeOf("string");
  });

  it("registers the section, the badge label and the three capabilities", () => {
    expect(at(m, "Settings.sections").approvals).toBeTypeOf("string");
    expect(at(m, "Sidebar").pendingApprovals).toBeTypeOf("string");
    for (const cap of ["approvals.review", "snippets.propose", "tags.propose"]) {
      const c = CAPABILITIES.find((x) => x.key === cap);
      expect(c, cap).toBeDefined();
      const id = cap.replace(/[.-]/g, "_");
      expect(at(m, `Permissions.cap.${id}`).label, cap).toBeTypeOf("string");
      expect(at(m, `Permissions.cap.${id}`).description, cap).toBeTypeOf("string");
    }
  });
});

describe("approvals strings agree between languages", () => {
  for (const ns of ["Approvals", "Settings.approvals"]) {
    it(`${ns} has the same keys and placeholders in en and ko`, () => {
      const en = at(messages.en, ns);
      const ko = at(messages.ko, ns);
      const enPaths = leafPaths(en).sort();
      expect(leafPaths(ko).sort()).toEqual(enPaths);
      for (const p of enPaths) {
        expect(placeholders(text(ko, p)), p).toEqual(placeholders(text(en, p)));
      }
    });
  }
});
