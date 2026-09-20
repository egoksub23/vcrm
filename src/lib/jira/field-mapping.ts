// ============================================================
// Custom-field mapping (0.45.0, migration 087): pure rules, no I/O.
//
// A Vircle ticket custom field (migration 066) is mapped to a Jira field of a
// compatible SIMPLE type. This file decides
//   - what a Jira create-metadata field IS (classifyJiraField) and which are
//     "not supported" (they are listed, never mappable),
//   - which Vircle types may map to which Jira kinds (the compatibility matrix),
//   - how a value converts each way (toJiraWrite / fromJiraValue),
//   (the echo guard, hashes of the last value pushed / seen, lives in ./field-echo.ts:
//   it needs node:crypto and this file is also used by the settings screens).
//
// Rich text: Jira "paragraph" fields hold ADF. Vircle text is written as a
// plain ADF document (paragraphs only) and ADF read back is flattened to plain
// text. Formatting is never round-tripped (text only).
// ============================================================

import { adfToPlainText, textToAdf } from "./adf";
import type { CreateField } from "./client";

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

export type VircleFieldType = "text" | "textarea" | "number" | "date" | "dropdown" | "checkbox";
export const VIRCLE_FIELD_TYPES: readonly VircleFieldType[] = ["text", "textarea", "number", "date", "dropdown", "checkbox"];

/** What a Jira field is, as far as Vircle can edit it. */
export type JiraFieldKind = "text" | "textarea" | "number" | "date" | "select" | "multicheckbox" | "labels" | "unsupported";

export type UnsupportedReason = "type" | "readonly" | "handled";

export interface JiraFieldInfo {
  id: string;
  name: string;
  kind: JiraFieldKind;
  required: boolean;
  options: { id: string; name: string }[];
  /** false = listed as "not supported", cannot be mapped. */
  supported: boolean;
  reason?: UnsupportedReason;
  /** Jira's own type, shown for unsupported fields ("user", "version" ...). */
  schemaType?: string;
}

export type MappingDirection = "to_jira" | "from_jira" | "both";
export type WhenMissing = "skip" | "clear" | "default";

export interface FieldMappingRow {
  id: string;
  account_id: string;
  connection_id: string;
  /** Upper-case project key, or "*" for every project. */
  project_key: string;
  ticket_field_id: string;
  jira_field_id: string;
  jira_field_name: string;
  jira_kind: JiraFieldKind;
  direction: MappingDirection;
  when_missing: WhenMissing;
  default_value: string | null;
  /** { label } for checkbox <-> labels. */
  config: { label?: string } | null;
}

export interface VircleFieldDef {
  id: string;
  label: string;
  field_type: VircleFieldType;
  options: string[];
  is_active?: boolean;
}

// ------------------------------------------------------------
// Classifying Jira fields
// ------------------------------------------------------------

const CF = "com.atlassian.jira.plugin.system.customfieldtypes:";

/** Fields Vircle fills itself when it creates an issue: never mappable. */
const HANDLED = new Set([
  "project",
  "issuetype",
  "summary",
  "description",
  "reporter",
  "priority",
  "assignee",
  "attachment",
  "issuelinks",
  "parent",
]);

const TEXT_CUSTOM = new Set([`${CF}textfield`, `${CF}url`]);

/** The kind of a create-metadata field; the reason is set for the unsupported ones. */
export function classifyJiraField(f: CreateField): JiraFieldInfo {
  const id = f.key ?? f.fieldId;
  const s = f.schema ?? {};
  const base = {
    id,
    name: f.name,
    required: !!f.required,
    options: (f.allowedValues ?? [])
      .map((v) => ({ id: v.id ?? "", name: v.name ?? v.value ?? v.key ?? "" }))
      .filter((o) => o.id && o.name),
    schemaType: s.custom ? `${s.type ?? "unknown"} (${s.custom.split(":").pop()})` : (s.type ?? "unknown"),
  };
  const no = (reason: UnsupportedReason): JiraFieldInfo => ({ ...base, kind: "unsupported", supported: false, reason });
  const yes = (kind: Exclude<JiraFieldKind, "unsupported">): JiraFieldInfo => ({ ...base, kind, supported: true });

  if (HANDLED.has(id)) return no("handled");
  // A field the screen offers no way to set (read-only): operations are listed when Jira knows them.
  const ops = f.operations;
  if (ops && !ops.includes("set") && !ops.includes("add")) return no("readonly");

  switch (s.type) {
    case "string":
      if (s.custom === `${CF}textarea` || s.system === "environment") return yes("textarea");
      if (s.custom && TEXT_CUSTOM.has(s.custom)) return yes("text");
      return no("type");
    case "number":
      return s.custom === `${CF}float` ? yes("number") : no("type");
    case "date":
      return yes("date");
    case "option":
      // Single select and radio buttons (a cascading select is "option-with-child": not supported).
      return base.options.length > 0 && (s.custom === `${CF}select` || s.custom === `${CF}radiobuttons`) ? yes("select") : no("type");
    case "array":
      if (s.items === "option" && s.custom === `${CF}multicheckboxes`) return base.options.length > 0 ? yes("multicheckbox") : no("type");
      if (s.items === "string" && (s.system === "labels" || s.custom === `${CF}labels`)) return yes("labels");
      return no("type");
    default:
      return no("type");
  }
}

/** Every field of a create-metadata answer, classified and sorted (supported first, then by name). */
export function parseCreateMeta(fields: readonly CreateField[]): JiraFieldInfo[] {
  return fields
    .map(classifyJiraField)
    .sort((a, b) => Number(b.supported) - Number(a.supported) || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------
// The compatibility matrix
// ------------------------------------------------------------

const COMPATIBLE: Record<VircleFieldType, readonly JiraFieldKind[]> = {
  text: ["text", "textarea"],
  textarea: ["text", "textarea"],
  number: ["number"],
  date: ["date"],
  dropdown: ["select"],
  checkbox: ["multicheckbox", "labels"],
};

export function compatibleJiraKinds(v: VircleFieldType): readonly JiraFieldKind[] {
  return COMPATIBLE[v] ?? [];
}

export function isCompatible(v: VircleFieldType, kind: JiraFieldKind): boolean {
  return COMPATIBLE[v]?.includes(kind) ?? false;
}

/** Why a proposed mapping is refused, or null when it is fine. */
export function mappingProblem(
  def: Pick<VircleFieldDef, "field_type">,
  jira: Pick<JiraFieldInfo, "kind" | "supported">,
): "unsupported" | "incompatible" | null {
  if (!jira.supported || jira.kind === "unsupported") return "unsupported";
  return isCompatible(def.field_type, jira.kind) ? null : "incompatible";
}

// ------------------------------------------------------------
// Value conversion
// ------------------------------------------------------------

/** The common domain both sides are compared in. */
export type Norm = string | number | boolean | null;

const MAX_TEXT = 255;

const yesName = /^(yes|true|checked|on|ja|oui)$/i;

const ONE_LINE = (s: string) => s.replace(/\s+/g, " ").trim();

/** Normalise a raw ticket value (jsonb) to the common domain; null = empty. */
export function normalizeVircleValue(def: Pick<VircleFieldDef, "field_type" | "options">, raw: unknown): Norm {
  if (raw === undefined || raw === null) return null;
  switch (def.field_type) {
    case "checkbox":
      return raw === true ? true : null;
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? n : null;
    }
    case "date": {
      const s = String(raw).trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    }
    case "dropdown": {
      const s = String(raw).trim();
      return s && def.options.some((o) => o === s) ? s : null;
    }
    default: {
      const s = String(raw).trim();
      return s || null;
    }
  }
}

/** What one field change looks like in a PUT /issue body. */
export interface FieldWrite {
  fields?: Record<string, unknown>;
  update?: Record<string, unknown[]>;
}

export type ToJira =
  | { kind: "write"; write: FieldWrite; /** what Jira will hold afterwards, in the common domain */ lands: Norm }
  | { kind: "skip"; reason: "missing" | "no_option" | "not_on_screen" | "unsupported" };

function optionByName(info: Pick<JiraFieldInfo, "options">, name: string) {
  const w = name.trim().toLowerCase();
  return info.options.find((o) => o.name.trim().toLowerCase() === w) ?? null;
}

/** The label a checkbox <-> labels mapping adds and removes. */
export function checkboxLabel(def: Pick<VircleFieldDef, "label">, config: FieldMappingRow["config"]): string {
  const raw = config?.label?.trim() || def.label;
  return (
    raw
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_.-]/g, "")
      .slice(0, 50) || "vircle"
  );
}

/**
 * Convert a ticket's value for a mapped field into the write Jira expects.
 * `missing` behaviour applies when the ticket holds no value.
 */
export function toJiraWrite(args: {
  def: VircleFieldDef;
  info: JiraFieldInfo;
  mapping: Pick<FieldMappingRow, "when_missing" | "default_value" | "config">;
  raw: unknown;
}): ToJira {
  const { def, info, mapping } = args;
  if (!info.supported || info.kind === "unsupported" || !isCompatible(def.field_type, info.kind)) {
    return { kind: "skip", reason: "unsupported" };
  }
  let norm = normalizeVircleValue(def, args.raw);
  if (norm === null) {
    if (mapping.when_missing === "skip") return { kind: "skip", reason: "missing" };
    if (mapping.when_missing === "default") {
      norm = normalizeVircleValue(def, defaultAs(def, mapping.default_value));
      if (norm === null) return { kind: "skip", reason: "missing" };
    }
    // "clear": a null lands as an empty Jira field.
  }
  const id = info.id;
  const set = (v: unknown, lands: Norm): ToJira => ({ kind: "write", write: { fields: { [id]: v } }, lands });

  switch (info.kind) {
    case "text": {
      if (norm === null) return set(null, null);
      const s = ONE_LINE(String(norm)).slice(0, MAX_TEXT);
      return set(s, s);
    }
    case "textarea": {
      if (norm === null) return set(null, null);
      const s = String(norm);
      return set(textToAdf(s), s.trim());
    }
    case "number":
      return typeof norm === "number" ? set(norm, norm) : set(null, null);
    case "date":
      return typeof norm === "string" ? set(norm, norm) : set(null, null);
    case "select": {
      if (norm === null) return set(null, null);
      const opt = optionByName(info, String(norm));
      return opt ? set({ id: opt.id }, opt.name) : { kind: "skip", reason: "no_option" };
    }
    case "multicheckbox": {
      if (norm !== true) return set([], null);
      const opt = info.options.find((o) => yesName.test(o.name)) ?? info.options[0];
      return opt ? set([{ id: opt.id }], true) : { kind: "skip", reason: "no_option" };
    }
    case "labels": {
      const label = checkboxLabel(def, mapping.config);
      return {
        kind: "write",
        write: { update: { [id]: [norm === true ? { add: label } : { remove: label }] } },
        lands: norm === true ? true : null,
      };
    }
    default:
      return { kind: "skip", reason: "unsupported" };
  }
}

function defaultAs(def: Pick<VircleFieldDef, "field_type">, d: string | null): unknown {
  if (d === null || d === "") return null;
  if (def.field_type === "checkbox") return /^(true|1|yes|on)$/i.test(d);
  return d;
}

export type FromJira =
  | { kind: "value"; norm: Norm }
  | { kind: "skip"; reason: "no_option" | "unsupported" };

/**
 * Read a Jira field value into the common domain (null = empty). A select whose
 * option the Vircle dropdown does not have is skipped (a dropdown is never set
 * to a choice it does not offer).
 */
export function fromJiraValue(args: {
  def: VircleFieldDef;
  info: JiraFieldInfo;
  raw: unknown;
  mapping: Pick<FieldMappingRow, "config">;
}): FromJira {
  const { def, info, raw } = args;
  if (!info.supported || info.kind === "unsupported" || !isCompatible(def.field_type, info.kind)) {
    return { kind: "skip", reason: "unsupported" };
  }
  if (raw === undefined || raw === null) return { kind: "value", norm: null };

  switch (info.kind) {
    case "text":
    case "textarea": {
      const s = typeof raw === "string" ? raw : adfToPlainText(raw, { max: 20_000 });
      const t = def.field_type === "text" ? ONE_LINE(s) : s.trim();
      return { kind: "value", norm: t || null };
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      return { kind: "value", norm: Number.isFinite(n) ? n : null };
    }
    case "date":
      return { kind: "value", norm: typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null };
    case "select": {
      const o = raw as { value?: unknown; name?: unknown };
      const name = typeof o.value === "string" ? o.value : typeof o.name === "string" ? o.name : "";
      if (!name.trim()) return { kind: "value", norm: null };
      const own = def.options.find((x) => x.trim().toLowerCase() === name.trim().toLowerCase());
      return own ? { kind: "value", norm: own } : { kind: "skip", reason: "no_option" };
    }
    case "multicheckbox":
      return { kind: "value", norm: Array.isArray(raw) && raw.length > 0 ? true : null };
    case "labels": {
      const label = checkboxLabel(def, args.mapping.config);
      return { kind: "value", norm: Array.isArray(raw) && raw.some((x) => x === label) ? true : null };
    }
    default:
      return { kind: "skip", reason: "unsupported" };
  }
}

/** A common-domain value as the ticket's custom_fields entry (undefined = clear it). */
export function normToTicketValue(def: Pick<VircleFieldDef, "field_type">, norm: Norm): string | number | boolean | undefined {
  if (norm === null) return undefined;
  if (def.field_type === "checkbox") return norm === true ? true : undefined;
  return norm;
}

// ------------------------------------------------------------
// Mappings for a project
// ------------------------------------------------------------

/** A project-specific mapping beats a "*" (every project) one for the same Vircle field. */
export function mappingsForProject(rows: readonly FieldMappingRow[], projectKey: string | null | undefined): FieldMappingRow[] {
  const key = projectKey?.toUpperCase() ?? "";
  const byField = new Map<string, FieldMappingRow>();
  for (const r of rows) if (r.project_key === "*") byField.set(r.ticket_field_id, r);
  for (const r of rows) if (r.project_key === key) byField.set(r.ticket_field_id, r);
  return [...byField.values()];
}

/** The field ids the sync has to ask Jira for, for every mapping that reads from Jira. */
export function readFieldIds(rows: readonly FieldMappingRow[]): string[] {
  return [...new Set(rows.filter((r) => r.direction !== "to_jira").map((r) => r.jira_field_id))];
}

/** Merge several writes into one PUT /issue body (fields set, list operations appended). */
export function mergeWrites(writes: readonly FieldWrite[]): FieldWrite {
  const out: FieldWrite = {};
  for (const w of writes) {
    if (w.fields) out.fields = { ...(out.fields ?? {}), ...w.fields };
    if (w.update) {
      out.update ??= {};
      for (const [k, ops] of Object.entries(w.update)) out.update[k] = [...(out.update[k] ?? []), ...ops];
    }
  }
  return out;
}
