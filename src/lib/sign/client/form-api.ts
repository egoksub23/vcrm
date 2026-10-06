// ============================================================
// Doc Sign form builder, browser side: the two calls it makes on a template, and what it reads from the
// workspace. The routes are POST /api/sign/templates/[id]/versions (body `{ fields, roles, defaults, form }`, answer
// `{ version, warnings }`) and GET /api/sign/templates/[id].
// ============================================================

import type { VersionWarning } from "../forms/api-types";
import type { SignTemplateVersionRow } from "../types";
import { signRequest } from "./api";
import type { VersionBody, VersionSnapshot } from "./form-save";

export interface TemplateMeta {
  id: string;
  name: string;
  status: "draft" | "active" | "archived";
  category_id: string | null;
  /** Migration 169: `form` for a form without a signature (no page editor, people who only fill in). Absent is `sign`. */
  mode?: "sign" | "form";
}

export interface VersionItem {
  id: string;
  version_no: number;
  created_at: string;
}

export interface LoadedTemplate {
  template: TemplateMeta;
  version: SignTemplateVersionRow | null;
  versions: VersionItem[];
}

export const loadTemplate = (templateId: string, signal?: AbortSignal): Promise<LoadedTemplate> => signRequest<LoadedTemplate>(`/api/sign/templates/${templateId}`, { signal });

/** What a screen keeps of a version row to decide, later, whether a newer one has been saved. */
export const snapshotOf = (v: SignTemplateVersionRow): VersionSnapshot => ({ id: v.id, fields: v.fields, roles: v.roles, defaults: v.defaults ?? {}, form: v.form ?? null });

export interface SavedVersion {
  version: SignTemplateVersionRow;
  warnings: VersionWarning[];
}

/** Save a new version. A route that does not send warnings yet is read as having none. */
export async function postVersion(templateId: string, body: VersionBody): Promise<SavedVersion> {
  const res = await signRequest<{ version: SignTemplateVersionRow; warnings?: VersionWarning[] }>(`/api/sign/templates/${templateId}/versions`, { json: body });
  return { version: res.version, warnings: res.warnings ?? [] };
}
