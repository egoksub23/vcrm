// ============================================================
// The Fields tab's server side: Jira field metadata for a project and issue
// type (cached 24 h, refreshable) and the field mappings themselves. Server
// only (service role). The classification and the compatibility matrix are in
// field-mapping.ts.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import type { CreateField, JiraClient } from "./client";
import {
  mappingProblem,
  parseCreateMeta,
  VIRCLE_FIELD_TYPES,
  type FieldMappingRow,
  type JiraFieldInfo,
  type MappingDirection,
  type VircleFieldDef,
  type WhenMissing,
} from "./field-mapping";

export const FIELD_META_TTL_MS = 24 * 3_600_000;
export const MAX_MAPPINGS = 60;

export interface FieldMeta {
  fields: JiraFieldInfo[];
  fetchedAt: string;
  cached: boolean;
}

/** Create-metadata fields of a project and issue type: from the cache, or from Jira (then cached). */
export async function getFieldMeta(args: {
  db: SupabaseClient;
  client: Pick<JiraClient, "listCreateFields">;
  connectionId: string;
  accountId: string;
  projectKey: string;
  issueTypeId: string;
  refresh?: boolean;
  now?: number;
}): Promise<FieldMeta> {
  const now = args.now ?? Date.now();
  if (!args.refresh) {
    const { data } = await args.db
      .from("jira_field_meta_cache")
      .select("fields, fetched_at")
      .eq("connection_id", args.connectionId)
      .eq("project_key", args.projectKey)
      .eq("issue_type_id", args.issueTypeId)
      .maybeSingle();
    const row = data as { fields: JiraFieldInfo[]; fetched_at: string } | null;
    if (row && Array.isArray(row.fields) && now - Date.parse(row.fetched_at) < FIELD_META_TTL_MS) {
      return { fields: row.fields, fetchedAt: row.fetched_at, cached: true };
    }
  }
  const res = await args.client.listCreateFields(args.projectKey, args.issueTypeId);
  const raw = (res?.fields ?? res?.values ?? []) as CreateField[];
  const fields = parseCreateMeta(raw);
  const fetchedAt = new Date(now).toISOString();
  await args.db.from("jira_field_meta_cache").upsert(
    { connection_id: args.connectionId, account_id: args.accountId, project_key: args.projectKey, issue_type_id: args.issueTypeId, fields, fetched_at: fetchedAt },
    { onConflict: "connection_id,project_key,issue_type_id" },
  );
  return { fields, fetchedAt, cached: false };
}

// ------------------------------------------------------------
// Mappings
// ------------------------------------------------------------

export interface MappingInput {
  projectKey: string;
  ticketFieldId: string;
  jiraFieldId: string;
  direction: MappingDirection;
  whenMissing: WhenMissing;
  defaultValue: string | null;
  label: string | null;
}

export type MappingRefusal = "no_such_field" | "no_such_jira_field" | "unsupported" | "incompatible" | "too_many" | "bad_direction";

/** Check a proposed mapping against the ticket field and the Jira field, without touching the database. */
export function validateMapping(
  input: Pick<MappingInput, "direction" | "whenMissing">,
  def: VircleFieldDef | undefined,
  jira: JiraFieldInfo | undefined,
): MappingRefusal | null {
  if (!["to_jira", "from_jira", "both"].includes(input.direction) || !["skip", "clear", "default"].includes(input.whenMissing)) return "bad_direction";
  if (!def || !VIRCLE_FIELD_TYPES.includes(def.field_type)) return "no_such_field";
  if (!jira) return "no_such_jira_field";
  return mappingProblem(def, jira);
}

/** Save (insert or replace) one mapping; the unique key is connection + project + ticket field. */
export async function saveMapping(args: {
  db: SupabaseClient;
  connectionId: string;
  accountId: string;
  input: MappingInput;
  def: VircleFieldDef;
  jira: JiraFieldInfo;
}): Promise<FieldMappingRow> {
  const { input, def, jira } = args;
  const config = jira.kind === "labels" && input.label ? { label: input.label.trim().slice(0, 50) } : null;
  const row = {
    account_id: args.accountId,
    connection_id: args.connectionId,
    project_key: input.projectKey,
    ticket_field_id: def.id,
    jira_field_id: jira.id,
    jira_field_name: jira.name.slice(0, 120),
    jira_kind: jira.kind,
    direction: input.direction,
    when_missing: input.whenMissing,
    default_value: input.whenMissing === "default" && input.defaultValue ? input.defaultValue.slice(0, 255) : null,
    config,
  };
  const { data, error } = await args.db
    .from("jira_field_mappings")
    .upsert(row, { onConflict: "connection_id,project_key,ticket_field_id" })
    .select("*")
    .single();
  if (error || !data) throw new Error(`Could not save the field mapping: ${error?.message ?? "unknown error"}`);
  return data as FieldMappingRow;
}
