// ============================================================
// Jira connection settings: validation and the status / priority mapping.
// Pure, no I/O. `normalizeSettings` is the one gate every stored or
// submitted settings object passes through: unknown keys are dropped, types
// are forced, sizes are capped. The SQL trigger that queues outbound status
// pushes reads the same JSON (direction.status_to_jira).
// ============================================================

import {
  DEFAULT_JIRA_SETTINGS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type JiraSettings,
  type JiraStatusCategory,
  type TicketPriorityValue,
  type TicketStatusValue,
} from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function name(v: unknown, max = 80): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s.length <= max ? s : null;
}

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,9}$/;

export function isProjectKey(v: unknown): v is string {
  return typeof v === "string" && PROJECT_KEY.test(v);
}

const MAX_OVERRIDES = 60;

export function normalizeSettings(raw: unknown): JiraSettings {
  const d = DEFAULT_JIRA_SETTINGS;
  const r = isRecord(raw) ? raw : {};
  const projects = isRecord(r.projects) ? r.projects : {};
  const mapping = isRecord(r.mapping) ? r.mapping : {};
  const direction = isRecord(r.direction) ? r.direction : {};
  const privacy = isRecord(r.privacy) ? r.privacy : {};

  const allowed = Array.isArray(projects.allowed)
    ? [...new Set(projects.allowed.filter(isProjectKey).map((k) => k.toUpperCase()))].slice(0, 100)
    : d.projects.allowed;
  let defaultProject = isProjectKey(projects.default_project) ? projects.default_project.toUpperCase() : null;
  // The default has to be one of the allowed projects (an empty list allows every project).
  if (defaultProject && allowed.length > 0 && !allowed.includes(defaultProject)) defaultProject = null;

  const priority: JiraSettings["mapping"]["priority"] = {};
  if (isRecord(mapping.priority)) {
    for (const p of TICKET_PRIORITIES) {
      const n = name(mapping.priority[p]);
      if (n) priority[p] = n;
    }
  }

  const statusFrom: Record<string, TicketStatusValue> = {};
  if (isRecord(mapping.status_from_jira)) {
    for (const [k, v] of Object.entries(mapping.status_from_jira).slice(0, MAX_OVERRIDES)) {
      const key = k.trim().toLowerCase();
      if (key && key.length <= 80 && (TICKET_STATUSES as readonly unknown[]).includes(v)) {
        statusFrom[key] = v as TicketStatusValue;
      }
    }
  }

  const statusTo: JiraSettings["mapping"]["status_to_jira"] = {};
  if (isRecord(mapping.status_to_jira)) {
    for (const s of TICKET_STATUSES) {
      const n = name(mapping.status_to_jira[s]);
      if (n) statusTo[s] = n;
    }
  }

  return {
    projects: {
      allowed,
      default_project: defaultProject,
      default_issue_type: name(projects.default_issue_type),
    },
    mapping: {
      priority,
      status_from_jira: statusFrom,
      status_to_jira: statusTo,
      category_label: bool(mapping.category_label, d.mapping.category_label),
    },
    direction: {
      comments_to_jira: bool(direction.comments_to_jira, d.direction.comments_to_jira),
      comments_from_jira: bool(direction.comments_from_jira, d.direction.comments_from_jira),
      status_from_jira: bool(direction.status_from_jira, d.direction.status_from_jira),
      status_to_jira: bool(direction.status_to_jira, d.direction.status_to_jira),
      assignee: bool(direction.assignee, d.direction.assignee),
    },
    privacy: {
      include_customer: bool(privacy.include_customer, d.privacy.include_customer),
      preview_before_send: bool(privacy.preview_before_send, d.privacy.preview_before_send),
    },
    done_behaviour: r.done_behaviour === "resolve" ? "resolve" : "note",
    resolution: name(r.resolution) ?? d.resolution,
    personal_data_report: bool(r.personal_data_report, d.personal_data_report),
  };
}

/** Which top-level sections differ (for the audit log: names only, never values). */
export function changedSections(a: JiraSettings, b: JiraSettings): string[] {
  const out: string[] = [];
  for (const k of ["projects", "mapping", "direction", "privacy"] as const) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  }
  for (const k of ["done_behaviour", "resolution", "personal_data_report"] as const) {
    if (a[k] !== b[k]) out.push(k);
  }
  return out;
}

/** Merge a partial patch into the current settings, section by section. */
export function applySettingsPatch(current: JiraSettings, patch: unknown): JiraSettings {
  if (!isRecord(patch)) return current;
  const merged: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (k in current) {
      merged[k] = isRecord(v) && isRecord((current as unknown as Record<string, unknown>)[k])
        ? { ...((current as unknown as Record<string, unknown>)[k] as object), ...v }
        : v;
    }
  }
  return normalizeSettings(merged);
}

// ------------------------------------------------------------
// Status mapping
// ------------------------------------------------------------

/** Default Jira -> Vircle: Jira's status category decides. */
const CATEGORY_TO_TICKET: Record<JiraStatusCategory, TicketStatusValue | null> = {
  new: "open",
  indeterminate: "in_progress",
  done: "resolved",
  undefined: null,
};

/** Default Vircle -> Jira is the same table reversed; pending and closed have no Jira twin. */
const TICKET_TO_CATEGORY: Partial<Record<TicketStatusValue, JiraStatusCategory>> = {
  open: "new",
  in_progress: "indeterminate",
  resolved: "done",
};

export function normalizeCategory(key: unknown): JiraStatusCategory | null {
  return key === "new" || key === "indeterminate" || key === "done" || key === "undefined" ? key : null;
}

/**
 * The ticket status a Jira status maps to: the admin's override for that
 * status NAME, else the category default. `explicit` tells the caller the
 * admin chose it (an explicit mapping to Resolved is honoured even when the
 * "notify instead of resolving" default is on).
 */
export function mapJiraStatusToTicket(
  settings: JiraSettings,
  status: { name?: string | null; category?: string | null },
): { status: TicketStatusValue; explicit: boolean } | null {
  const byName = status.name ? settings.mapping.status_from_jira[status.name.trim().toLowerCase()] : undefined;
  if (byName) return { status: byName, explicit: true };
  const cat = normalizeCategory(status.category);
  const def = cat ? CATEGORY_TO_TICKET[cat] : null;
  return def ? { status: def, explicit: false } : null;
}

export interface JiraTarget {
  /** Land on this status name (case-insensitive), from an admin override. */
  name?: string;
  /** Otherwise land on any status of this category. */
  category?: JiraStatusCategory;
}

/** Where a ticket status should put the Jira issue; null = leave Jira alone. */
export function wantedJiraTarget(settings: JiraSettings, status: TicketStatusValue): JiraTarget | null {
  const override = settings.mapping.status_to_jira[status];
  if (override) return { name: override };
  const cat = TICKET_TO_CATEGORY[status];
  return cat ? { category: cat } : null;
}

export function priorityNameFor(settings: JiraSettings, priority: TicketPriorityValue): string | null {
  return settings.mapping.priority[priority] ?? null;
}

// ------------------------------------------------------------
// Transitions: pick the one that lands on the wanted status
// ------------------------------------------------------------

export interface JiraTransition {
  id: string;
  name?: string;
  to?: { id?: string; name?: string; statusCategory?: { key?: string } };
  hasScreen?: boolean;
  isAvailable?: boolean;
  isConditional?: boolean;
  fields?: Record<string, { required?: boolean; hasDefaultValue?: boolean; name?: string; allowedValues?: { name?: string; id?: string }[] }>;
}

export type TransitionChoice =
  | { kind: "already" }
  | { kind: "none" }
  | { kind: "transition"; transition: JiraTransition };

/**
 * Choose ONE transition that lands on the target. Never a chain: if the
 * issue cannot get there in one step, the answer is "none" and Jira is left
 * alone. `current` is where the issue is now.
 */
export function pickTransition(
  transitions: readonly JiraTransition[],
  target: JiraTarget,
  current: { name?: string | null; category?: string | null },
): TransitionChoice {
  const wantName = target.name?.trim().toLowerCase();
  if (wantName && current.name?.trim().toLowerCase() === wantName) return { kind: "already" };
  if (!wantName && target.category && current.category === target.category) return { kind: "already" };

  const matches = transitions.filter((t) => {
    if (t.isAvailable === false) return false;
    if (wantName) return t.to?.name?.trim().toLowerCase() === wantName;
    return target.category ? t.to?.statusCategory?.key === target.category : false;
  });
  if (matches.length === 0) return { kind: "none" };

  const rank = (t: JiraTransition) =>
    (t.hasScreen ? 4 : 0) + (t.isConditional ? 2 : 0) + (t.isAvailable === true ? 0 : 1);
  const sorted = [...matches].sort((a, b) => rank(a) - rank(b) || Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
  return { kind: "transition", transition: sorted[0] };
}

export type TransitionFields =
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; missing: string[] };

/**
 * What a transition screen demands. A required resolution is supplied from
 * the settings; any other required field without a default is something we
 * cannot invent, so the answer is "not ok" and Jira is left alone.
 */
export function transitionFields(transition: JiraTransition, resolutionName: string): TransitionFields {
  const fields: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [id, f] of Object.entries(transition.fields ?? {})) {
    if (!f?.required || f.hasDefaultValue) continue;
    if (id === "resolution") {
      const allowed = f.allowedValues ?? [];
      const wanted = allowed.find((v) => v.name?.toLowerCase() === resolutionName.toLowerCase());
      // Prefer the configured resolution; if the site has no such value, the first allowed one.
      const chosen = wanted ?? allowed[0];
      fields.resolution = chosen?.name ? { name: chosen.name } : { name: resolutionName };
    } else {
      missing.push(f.name ?? id);
    }
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, fields };
}
