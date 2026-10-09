// ============================================================
// Doc Sign editor: the geometry and bookkeeping of fields and roles, as pure functions (no React, no DOM).
//
// Everything on a page is a fraction of the page (0..1, origin top-left), the same numbers the PDF engine
// reads. "Never outside the page" is enforced here: every function that returns a rectangle clamps it, so
// the screens cannot place a field the server would refuse (`outside_page`, `too_small`).
// The shapes are `PlacedField`/`FieldType` (pdf/types.ts) and `SignRole` (types.ts); the rules the server
// applies are in rules.ts and are run in the browser by the issues panel.
// ============================================================

import type { FieldType, PlacedField } from "../pdf/types";
import { MAX_FIELDS, MAX_ROLES, SENDER_ROLE, SIGNER_ONLY_TYPES, type Issue } from "../rules";
import type { SignerKind, SignRole } from "../types";
import { roleColorIndex, ROLE_COLOR_COUNT } from "./colors";

// ---- rectangles ----------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Smallest a field may be made in the editor (the server's own floor is 0.005 x 0.003). */
export const MIN_FIELD_W = 0.02;
export const MIN_FIELD_H = 0.012;

const PRECISION = 1e5;
const round = (n: number) => Math.round(n * PRECISION) / PRECISION;
const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);
const finiteOr = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);

export const rectOf = (f: Rect): Rect => ({ x: f.x, y: f.y, w: f.w, h: f.h });

/** The rectangle brought inside the page and up to the minimum size. Never throws, never returns NaN. */
export function clampRect(r: Rect, minW = MIN_FIELD_W, minH = MIN_FIELD_H): Rect {
  const w = clamp(finiteOr(r.w, minW), minW, 1);
  const h = clamp(finiteOr(r.h, minH), minH, 1);
  const x = clamp(finiteOr(r.x, 0), 0, 1 - w);
  const y = clamp(finiteOr(r.y, 0), 0, 1 - h);
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

/** Move without changing the size; stops at the page edge. */
export function moveRect(r: Rect, dx: number, dy: number): Rect {
  return clampRect({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }, Math.min(r.w, MIN_FIELD_W), Math.min(r.h, MIN_FIELD_H));
}

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Drag a handle of `start` by (dx, dy). The opposite edges stay put; the result stays on the page and above the minimum. */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number, minW = MIN_FIELD_W, minH = MIN_FIELD_H): Rect {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (handle.includes("w")) left = clamp(left + dx, 0, right - minW);
  if (handle.includes("e")) right = clamp(right + dx, left + minW, 1);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - minH);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + minH, 1);
  return clampRect({ x: left, y: top, w: right - left, h: bottom - top }, minW, minH);
}

/** A rectangle from two corners in any order (a drag to draw a field). */
export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Is `a` close enough to `b` to be the same place (used so "copy to every page" is safe to repeat)? */
export function sameSpot(a: Rect, b: Rect, tolerance = 0.002): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance && Math.abs(a.w - b.w) <= tolerance && Math.abs(a.h - b.h) <= tolerance;
}

// ---- snapping -------------------------------------------------------------------------------

export interface SnapTargets {
  xs: number[];
  ys: number[];
}

/** The lines other fields and the page offer to snap to: edges and centres, plus the page edges and middle. */
export function snapTargets(others: readonly Rect[]): SnapTargets {
  const xs = [0, 0.5, 1];
  const ys = [0, 0.5, 1];
  for (const o of others) {
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  return { xs, ys };
}

function nearest(value: number, targets: readonly number[], threshold: number): number | null {
  let best: number | null = null;
  let bestDist = threshold;
  for (const t of targets) {
    const d = Math.abs(t - value);
    if (d <= bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}

export interface SnapResult {
  rect: Rect;
  /** The vertical line (x) and horizontal line (y) the field snapped to, for drawing a guide. */
  guideX: number | null;
  guideY: number | null;
}

/** Snap a moved rectangle's left, centre or right edge (and top, middle, bottom) to the nearest target within `threshold`. */
export function snapMove(r: Rect, targets: SnapTargets, threshold: number): SnapResult {
  let guideX: number | null = null;
  let guideY: number | null = null;
  let { x, y } = r;
  let bestX = threshold + 1;
  for (const offset of [0, r.w / 2, r.w]) {
    const t = nearest(r.x + offset, targets.xs, threshold);
    if (t !== null && Math.abs(t - (r.x + offset)) < bestX) {
      bestX = Math.abs(t - (r.x + offset));
      x = t - offset;
      guideX = t;
    }
  }
  let bestY = threshold + 1;
  for (const offset of [0, r.h / 2, r.h]) {
    const t = nearest(r.y + offset, targets.ys, threshold);
    if (t !== null && Math.abs(t - (r.y + offset)) < bestY) {
      bestY = Math.abs(t - (r.y + offset));
      y = t - offset;
      guideY = t;
    }
  }
  const rect = moveRect({ ...r, x, y }, 0, 0);
  // a snap the page edge undid is no snap
  if (guideX !== null && Math.abs(rect.x - x) > 1e-6) guideX = null;
  if (guideY !== null && Math.abs(rect.y - y) > 1e-6) guideY = null;
  return { rect, guideX, guideY };
}

/** Snap the edges a handle is moving (and only those) to the nearest target. */
export function snapResize(r: Rect, handle: Handle, targets: SnapTargets, threshold: number, minW = MIN_FIELD_W, minH = MIN_FIELD_H): SnapResult {
  let left = r.x;
  let top = r.y;
  let right = r.x + r.w;
  let bottom = r.y + r.h;
  let guideX: number | null = null;
  let guideY: number | null = null;
  if (handle.includes("w")) {
    const t = nearest(left, targets.xs, threshold);
    if (t !== null && right - t >= minW) {
      left = t;
      guideX = t;
    }
  }
  if (handle.includes("e")) {
    const t = nearest(right, targets.xs, threshold);
    if (t !== null && t - left >= minW) {
      right = t;
      guideX = t;
    }
  }
  if (handle.includes("n")) {
    const t = nearest(top, targets.ys, threshold);
    if (t !== null && bottom - t >= minH) {
      top = t;
      guideY = t;
    }
  }
  if (handle.includes("s")) {
    const t = nearest(bottom, targets.ys, threshold);
    if (t !== null && t - top >= minH) {
      bottom = t;
      guideY = t;
    }
  }
  return { rect: clampRect({ x: left, y: top, w: right - left, h: bottom - top }, minW, minH), guideX, guideY };
}

export type NudgeDirection = "left" | "right" | "up" | "down";

/**
 * Move by the arrow keys: 1 point, or 10 with Shift. `page` is the page size in points, so the step is the
 * same on screen at any zoom.
 */
export function nudgeRect(r: Rect, direction: NudgeDirection, big: boolean, page: { width: number; height: number }): Rect {
  const points = big ? 10 : 1;
  const dx = points / Math.max(1, page.width);
  const dy = points / Math.max(1, page.height);
  switch (direction) {
    case "left":
      return moveRect(r, -dx, 0);
    case "right":
      return moveRect(r, dx, 0);
    case "up":
      return moveRect(r, 0, -dy);
    default:
      return moveRect(r, 0, dy);
  }
}

/** Resize from the keyboard (Alt + arrows): the right and bottom edges move; the top-left corner stays. */
export function nudgeSize(r: Rect, direction: NudgeDirection, big: boolean, page: { width: number; height: number }): Rect {
  const points = big ? 10 : 1;
  const dx = points / Math.max(1, page.width);
  const dy = points / Math.max(1, page.height);
  switch (direction) {
    case "left":
      return resizeRect(r, "e", -dx, 0);
    case "right":
      return resizeRect(r, "e", dx, 0);
    case "up":
      return resizeRect(r, "s", 0, -dy);
    default:
      return resizeRect(r, "s", 0, dy);
  }
}

// ---- field defaults ---------------------------------------------------------------------------

/** Width as a fraction of the page and height in page-width units (so a checkbox is square on any page shape). */
const DEFAULT_UNITS: Record<FieldType, readonly [number, number]> = {
  signature: [0.26, 0.075],
  initials: [0.1, 0.05],
  name: [0.28, 0.028],
  date_signed: [0.18, 0.028],
  date: [0.18, 0.028],
  text: [0.3, 0.028],
  number: [0.18, 0.028],
  static_text: [0.3, 0.028],
  checkbox: [0.03, 0.03],
  dropdown: [0.24, 0.028],
  upload: [0.26, 0.12],
};

/** Default size of a new field, as fractions of the page. `aspect` is page height divided by page width. */
export function defaultSize(type: FieldType, aspect: number): { w: number; h: number } {
  const [wUnits, hUnits] = DEFAULT_UNITS[type];
  const a = clamp(finiteOr(aspect, 1.4142), 0.2, 5);
  return { w: wUnits, h: round(hUnits / a) };
}

/**
 * Where a new signature block goes on a page: centred, at `centreY` (a fraction of the page height, the middle of the part in view), moved down
 * past any block already there so two never sit on one another. `aspect` is page height divided by page width.
 */
export function signatureRectFor(fields: readonly { page: number; x: number; y: number }[], page: number, aspect: number, centreY: number): Rect {
  const { w, h } = defaultSize("signature", aspect);
  const cy = Math.min(0.92, Math.max(0.08, centreY));
  const x = Math.max(0, 0.5 - w / 2);
  let y = Math.max(0, Math.min(1 - h, cy - h / 2));
  for (let i = 0; i < 12 && fields.some((f) => f.page === page && Math.abs(f.y - y) < h * 0.9 && Math.abs(f.x - x) < w * 0.9); i++) y = Math.min(1 - h, y + h * 1.1);
  return { x, y, w, h };
}

/** The types a person fills in or signs (they are "required" by default); the rest are written by the engine or the sender. */
export function defaultRequired(type: FieldType): boolean {
  return type !== "static_text" && type !== "date_signed" && type !== "name" && type !== "checkbox";
}

/** Types whose value the sender may supply when the document is made (a "merge" field). */
export function canMerge(type: FieldType): boolean {
  return type === "text" || type === "number" || type === "date" || type === "static_text";
}

export const isSignerOnly = (type: FieldType): boolean => SIGNER_ONLY_TYPES.includes(type);

/** Is `type` allowed for a role of this kind (signature, initials and date_signed are the act of signing)? */
export function roleKindAllows(kind: SignerKind, type: FieldType): boolean {
  return kind === "signer" || !isSignerOnly(type);
}

// ---- keys ---------------------------------------------------------------------------------------

/** The server's pattern for field, role and merge keys (rules.ts KEY_RE). */
export const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A new field key like "f_8k2x" that is not in `taken`. `random` is injectable for tests. */
export function newFieldKey(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (let length = 4; length <= 12; length += 2) {
    for (let attempt = 0; attempt < 40; attempt++) {
      let s = "f_";
      for (let i = 0; i < length; i++) s += KEY_ALPHABET[Math.min(KEY_ALPHABET.length - 1, Math.floor(random() * KEY_ALPHABET.length))];
      if (!taken.has(s)) return s;
    }
  }
  // random is stuck (a test double): count up
  let n = taken.size;
  while (taken.has(`f_${n}`)) n++;
  return `f_${n}`;
}

export const keysOf = (fields: readonly PlacedField[]): Set<string> => new Set(fields.map((f) => f.key));

// ---- creating, duplicating, copying fields -------------------------------------------------------

/** The role a new field of `type` belongs to: the preferred one when it may own that type, else the first that may. "" if none can. */
export function roleForType(type: FieldType, roles: readonly SignRole[], preferred?: string | null): string {
  if (type === "static_text") return SENDER_ROLE;
  const preferredRole = preferred ? roles.find((r) => r.key === preferred) : undefined;
  if (preferredRole && roleKindAllows(preferredRole.kind, type)) return preferredRole.key;
  return roles.find((r) => roleKindAllows(r.kind, type))?.key ?? "";
}

export interface NewFieldInput {
  type: FieldType;
  page: number;
  rect: Rect;
  role: string;
  taken: ReadonlySet<string>;
  random?: () => number;
  overrides?: Partial<PlacedField>;
}

export function createField(input: NewFieldInput): PlacedField {
  const rect = clampRect(input.rect);
  return {
    key: newFieldKey(input.taken, input.random),
    type: input.type,
    role: input.role,
    page: input.page,
    ...rect,
    required: defaultRequired(input.type),
    ...input.overrides,
  };
}

/** A default-sized rectangle centred on a point of the page (a click), kept inside the page. */
export function rectAtPoint(type: FieldType, aspect: number, point: { x: number; y: number }): Rect {
  const { w, h } = defaultSize(type, aspect);
  return clampRect({ x: point.x - w / 2, y: point.y - h / 2, w, h });
}

/** The rectangle for a drag from `a` to `b`; a drag too short to mean it (a click) gives the default size at `a`. */
export function rectForDraw(type: FieldType, aspect: number, a: { x: number; y: number }, b: { x: number; y: number }, minDrag: number): Rect {
  const r = rectFromPoints(a, b);
  if (r.w < minDrag && r.h < minDrag) return rectAtPoint(type, aspect, a);
  return clampRect(r);
}

const DUPLICATE_OFFSET = 0.02;

/** A copy with a new key, a little down and to the right (or left/up when there is no room). */
export function duplicateField(f: PlacedField, taken: ReadonlySet<string>, random?: () => number): PlacedField {
  const dx = f.x + f.w + DUPLICATE_OFFSET <= 1 ? DUPLICATE_OFFSET : -DUPLICATE_OFFSET;
  const dy = f.y + f.h + DUPLICATE_OFFSET <= 1 ? DUPLICATE_OFFSET : -DUPLICATE_OFFSET;
  return { ...f, ...moveRect(f, dx, dy), key: newFieldKey(taken, random) };
}

/** The same field on another page, at the same spot. */
export function cloneToPage(f: PlacedField, page: number, taken: ReadonlySet<string>, random?: () => number): PlacedField {
  return { ...f, page, key: newFieldKey(taken, random) };
}

/**
 * "Copy to every page": the fields to add so that `source` appears at the same spot on every other page
 * (or on `pages` when given). A page that already has the same kind of field there is skipped, so the
 * command is safe to repeat. Stops at MAX_FIELDS.
 */
export function copyToPages(
  fields: readonly PlacedField[],
  source: PlacedField,
  pageCount: number,
  options: { pages?: readonly number[]; random?: () => number } = {},
): { added: PlacedField[]; skipped: number } {
  const taken = keysOf(fields);
  const targets = options.pages ?? Array.from({ length: pageCount }, (_, i) => i);
  const added: PlacedField[] = [];
  let skipped = 0;
  for (const page of targets) {
    if (page === source.page || page < 0 || page >= pageCount) continue;
    const exists = fields.some((f) => f.page === page && f.type === source.type && f.role === source.role && sameSpot(f, source));
    if (exists || fields.length + added.length >= MAX_FIELDS) {
      skipped++;
      continue;
    }
    const copy = cloneToPage(source, page, taken, options.random);
    taken.add(copy.key);
    added.push(copy);
  }
  return { added, skipped };
}

/**
 * Paste copied fields: new keys, onto `page`. Pasting onto the page they came from shifts them a little so the
 * copy can be seen; `round` counts repeated pastes so each is shifted further.
 */
export function pasteFields(
  clipboard: readonly PlacedField[],
  fields: readonly PlacedField[],
  page: number,
  round: number,
  random?: () => number,
): PlacedField[] {
  const taken = keysOf(fields);
  const out: PlacedField[] = [];
  for (const f of clipboard) {
    if (fields.length + out.length >= MAX_FIELDS) break;
    const shift = f.page === page ? DUPLICATE_OFFSET * Math.max(1, round) : 0;
    const copy: PlacedField = { ...f, page, ...moveRect(f, shift, shift), key: newFieldKey(taken, random) };
    taken.add(copy.key);
    out.push(copy);
  }
  return out;
}

/** Fields in reading order (page, then top to bottom, then left to right). */
export function readingOrder(fields: readonly PlacedField[]): PlacedField[] {
  return [...fields].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}

// ---- merge keys ------------------------------------------------------------------------------------

export interface MergeKeyUse {
  key: string;
  count: number;
  /** The first field (in reading order) that uses it. */
  firstField: string;
}

/** The merge keys the fields use, in reading order of first use, with how many fields use each. */
export function mergeKeysOf(fields: readonly PlacedField[]): MergeKeyUse[] {
  const out = new Map<string, MergeKeyUse>();
  for (const f of readingOrder(fields)) {
    if (!f.merge) continue;
    const seen = out.get(f.merge);
    if (seen) seen.count++;
    else out.set(f.merge, { key: f.merge, count: 1, firstField: f.key });
  }
  return [...out.values()];
}

/** What a person typed, made into a key the rules accept: letters, digits and underscores; starts with a letter; at most 40. */
export function sanitizeKey(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, "").replace(/^[^A-Za-z]+/, "").slice(0, 40);
}

/** A merge key nobody uses yet: "value_1", "value_2", ... */
export function suggestMergeKey(fields: readonly PlacedField[], base = "value"): string {
  const used = new Set(fields.map((f) => f.merge).filter((m): m is string => !!m));
  for (let n = 1; n < 1000; n++) {
    const k = `${base}_${n}`;
    if (!used.has(k)) return k;
  }
  return `${base}_${used.size + 1}`;
}

/**
 * Set or clear the merge key of a field. A field the sender fills belongs to the sender and is never required of
 * a signer; clearing it hands the field back to a role that may own it.
 */
export function applyMerge(f: PlacedField, merge: string | undefined, roles: readonly SignRole[], preferredRole?: string | null): PlacedField {
  if (merge) return { ...f, merge, role: SENDER_ROLE, required: false };
  const { merge: _unused, ...rest } = f;
  void _unused;
  if (f.type === "static_text") return { ...rest, role: SENDER_ROLE };
  return { ...rest, role: roleForType(f.type, roles, preferredRole) || f.role, required: defaultRequired(f.type) };
}

// ---- roles --------------------------------------------------------------------------------------------

/** A role key not used yet: "role_1", "role_2", ... (never "sender"). */
export function nextRoleKey(roles: readonly SignRole[]): string {
  const used = new Set(roles.map((r) => r.key));
  for (let n = 1; n < 1000; n++) {
    const k = `role_${n}`;
    if (!used.has(k)) return k;
  }
  return `role_${used.size + 1}`;
}

/** The first colour 0..5 no role uses; when all are used, the least used (lowest first). */
export function nextRoleColor(roles: readonly SignRole[]): number {
  const counts = new Array<number>(ROLE_COLOR_COUNT).fill(0);
  for (const r of roles) counts[roleColorIndex(r.color)]++;
  let best = 0;
  for (let i = 1; i < ROLE_COLOR_COUNT; i++) if (counts[i] < counts[best]) best = i;
  return best;
}

export const canAddRole = (roles: readonly SignRole[]): boolean => roles.length < MAX_ROLES;

/** Add a role with the next free key and colour. Returns the new roles and the role, or null at the maximum. */
export function addRole(roles: readonly SignRole[], input: { label: string; kind: SignerKind }): { roles: SignRole[]; role: SignRole } | null {
  if (!canAddRole(roles)) return null;
  const role: SignRole = { key: nextRoleKey(roles), label: input.label.slice(0, 60), kind: input.kind, color: nextRoleColor(roles) };
  return { roles: [...roles, role], role };
}

export function updateRole(roles: readonly SignRole[], key: string, patch: Partial<Pick<SignRole, "label" | "kind" | "color">>): SignRole[] {
  return roles.map((r) => (r.key === key ? { ...r, ...patch, label: patch.label !== undefined ? patch.label.slice(0, 60) : r.label, color: patch.color !== undefined ? roleColorIndex(patch.color) : r.color } : r));
}

export const countRoleFields = (fields: readonly PlacedField[], roleKey: string): number => fields.filter((f) => f.role === roleKey).length;

/**
 * Delete a role. Its fields go to `reassignTo` when that role may own them, and are removed otherwise (also when
 * `reassignTo` is null). Static and merge fields belong to the sender and only lose the role they were filed under.
 */
export function removeRole(roles: readonly SignRole[], fields: readonly PlacedField[], key: string, reassignTo: string | null): { roles: SignRole[]; fields: PlacedField[]; removed: number; moved: number } {
  const remaining = roles.filter((r) => r.key !== key);
  const target = reassignTo ? remaining.find((r) => r.key === reassignTo) : undefined;
  const out: PlacedField[] = [];
  let removed = 0;
  let moved = 0;
  for (const f of fields) {
    if (f.role !== key) {
      out.push(f);
    } else if (f.type === "static_text" || f.merge) {
      out.push({ ...f, role: SENDER_ROLE });
    } else if (target && roleKindAllows(target.kind, f.type)) {
      out.push({ ...f, role: target.key });
      moved++;
    } else {
      removed++;
    }
  }
  return { roles: remaining, fields: out, removed, moved };
}

/** The role object a field is drawn with: its role, or null for the sender. */
export function roleOfField(f: PlacedField, roles: readonly SignRole[]): SignRole | null {
  if (f.role === SENDER_ROLE) return null;
  return roles.find((r) => r.key === f.role) ?? null;
}

// ---- dates ------------------------------------------------------------------------------------------------

/** The date format the rules accept (rules.ts DATE_FORMAT_RE): tokens DD D MM M MMM MMMM YYYY YY and the separators space / . , - */
export function isValidDateFormat(format: string): boolean {
  return format.length > 0 && format.length <= 30 && /^(?:YYYY|YY|MMMM|MMM|MM|M|DD|D|[ /.,\-])+$/.test(format);
}

export const DATE_FORMAT_PRESETS: readonly string[] = ["DD MMM YYYY", "D MMMM YYYY", "DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "DD.MM.YYYY"];
export const DEFAULT_DATE_FORMAT = "DD MMM YYYY";

// ---- messages -------------------------------------------------------------------------------------------------

/** Every issue code rules.ts can report for a layout, and the ones the routes add around it. Each has a message under `issues.<code>`. */
export const ISSUE_CODES = [
  "too_many_roles",
  "bad_role_key",
  "duplicate_role",
  "bad_role_label",
  "bad_role_kind",
  "too_many_fields",
  "bad_field_key",
  "duplicate_field_key",
  "bad_field_type",
  "unknown_role",
  "filler_cannot_sign",
  "page_out_of_range",
  "outside_page",
  "too_small",
  "bad_options",
  "bad_date_format",
  "bad_decimals",
  "bad_static_text",
  "bad_merge_key",
  "bad_font_size",
  "bad_label",
] as const;

/** Codes a failed call can carry that the editor words under `errors.<code>`; any other code gets `errors.generic`. */
export const ERROR_CODES = [
  "network",
  "signed_out",
  "forbidden",
  "rate_limited",
  "invalid_layout",
  "bad_layout",
  "document_not_draft",
  "document_frozen",
  "document_not_found",
  "template_not_found",
  "template_not_ready",
  "template_has_no_version",
  "bad_name",
  "bad_status",
  "category_not_found",
  "bad_merge_values",
  "request_failed",
] as const;

export function issueMessageKey(code: string): string {
  return (ISSUE_CODES as readonly string[]).includes(code) ? `issues.${code}` : "issues.unknown";
}

export function errorMessageKey(code: string): string {
  return (ERROR_CODES as readonly string[]).includes(code) ? `errors.${code}` : "errors.generic";
}

/** What an issue is about, for selecting it from the issues panel. */
export function issueTarget(issue: Issue): { field?: string; role?: string } {
  return { field: issue.field, role: issue.role };
}
