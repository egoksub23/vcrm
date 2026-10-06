import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FIELD_TYPES, type FieldType, type PlacedField } from "../pdf/types";
import { MAX_FIELDS, MAX_ROLES, SENDER_ROLE, validateFields, validateRoles } from "../rules";
import type { SignRole } from "../types";
import { ROLE_COLOR_COUNT } from "./colors";
import {
  ERROR_CODES,
  ISSUE_CODES,
  KEY_PATTERN,
  MIN_FIELD_H,
  MIN_FIELD_W,
  addRole,
  applyMerge,
  canMerge,
  clampRect,
  copyToPages,
  createField,
  defaultSize,
  duplicateField,
  errorMessageKey,
  isValidDateFormat,
  issueMessageKey,
  keysOf,
  mergeKeysOf,
  moveRect,
  newFieldKey,
  nextRoleColor,
  nextRoleKey,
  nudgeRect,
  nudgeSize,
  pasteFields,
  rectAtPoint,
  rectForDraw,
  removeRole,
  resizeRect,
  roleForType,
  sanitizeKey,
  snapMove,
  snapResize,
  snapTargets,
  suggestMergeKey,
  updateRole,
  type Rect,
} from "./layout";

const signer = (key: string, color = 0): SignRole => ({ key, label: key, kind: "signer", color });
const filler = (key: string, color = 1): SignRole => ({ key, label: key, kind: "filler", color });
const field = (over: Partial<PlacedField> = {}): PlacedField => ({ key: "f_aaaa", type: "text", role: "a", page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05, required: true, ...over });

/** A deterministic "random": counts through the alphabet. */
function counter() {
  let n = 0;
  return () => ((n++ * 7) % 36) / 36;
}

describe("clampRect", () => {
  it("brings a rectangle inside the page", () => {
    expect(clampRect({ x: -0.2, y: 0.95, w: 0.3, h: 0.2 })).toEqual({ x: 0, y: 0.8, w: 0.3, h: 0.2 });
    expect(clampRect({ x: 0.9, y: 0.1, w: 0.3, h: 0.1 })).toEqual({ x: 0.7, y: 0.1, w: 0.3, h: 0.1 });
  });
  it("applies the minimum size and never exceeds the page", () => {
    const r = clampRect({ x: 0.5, y: 0.5, w: 0, h: -1 });
    expect(r.w).toBe(MIN_FIELD_W);
    expect(r.h).toBe(MIN_FIELD_H);
    expect(clampRect({ x: 0, y: 0, w: 5, h: 5 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
  it("survives NaN and Infinity", () => {
    const r = clampRect({ x: NaN, y: Infinity, w: NaN, h: NaN });
    for (const v of Object.values(r)) expect(Number.isFinite(v)).toBe(true);
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
  });
  it("always passes the server's geometry rules", () => {
    const roles = [signer("a")];
    for (const raw of [{ x: -5, y: 7, w: 0.0001, h: 99 }, { x: 0.999, y: 0.999, w: 0.5, h: 0.5 }, { x: 0.3, y: 0.3, w: 0.001, h: 0.001 }]) {
      const issues = validateFields([field({ ...clampRect(raw) })], roles, 1);
      expect(issues).toEqual([]);
    }
  });
  it("keeps the editor minimum above the server minimum", () => {
    expect(MIN_FIELD_W).toBeGreaterThanOrEqual(0.005);
    expect(MIN_FIELD_H).toBeGreaterThanOrEqual(0.003);
  });
});

describe("moveRect", () => {
  it("moves and stops at the page edge without changing size", () => {
    const r: Rect = { x: 0.1, y: 0.1, w: 0.2, h: 0.1 };
    expect(moveRect(r, 0.1, 0.2)).toEqual({ x: 0.2, y: 0.3, w: 0.2, h: 0.1 });
    expect(moveRect(r, 5, 5)).toEqual({ x: 0.8, y: 0.9, w: 0.2, h: 0.1 });
    expect(moveRect(r, -5, -5)).toEqual({ x: 0, y: 0, w: 0.2, h: 0.1 });
  });
  it("does not grow a field smaller than the editor minimum", () => {
    const tiny: Rect = { x: 0.1, y: 0.1, w: 0.01, h: 0.005 };
    const moved = moveRect(tiny, 0.1, 0);
    expect(moved.w).toBe(0.01);
    expect(moved.h).toBe(0.005);
  });
});

describe("resizeRect", () => {
  const start: Rect = { x: 0.2, y: 0.2, w: 0.3, h: 0.1 };
  it("moves only the edges of the handle", () => {
    expect(resizeRect(start, "e", 0.1, 0.5)).toEqual({ x: 0.2, y: 0.2, w: 0.4, h: 0.1 });
    expect(resizeRect(start, "s", 0.5, 0.1)).toEqual({ x: 0.2, y: 0.2, w: 0.3, h: 0.2 });
    expect(resizeRect(start, "nw", -0.1, -0.1)).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.2 });
    expect(resizeRect(start, "se", 0.1, 0.1)).toEqual({ x: 0.2, y: 0.2, w: 0.4, h: 0.2 });
  });
  it("keeps the opposite edge fixed when shrinking to the minimum", () => {
    const r = resizeRect(start, "w", 5, 0);
    expect(r.x + r.w).toBeCloseTo(0.5, 5);
    expect(r.w).toBe(MIN_FIELD_W);
    const t = resizeRect(start, "n", 0, 5);
    expect(t.y + t.h).toBeCloseTo(0.3, 5);
    expect(t.h).toBe(MIN_FIELD_H);
  });
  it("stops at the page edge", () => {
    expect(resizeRect(start, "e", 5, 0).x + resizeRect(start, "e", 5, 0).w).toBeCloseTo(1, 5);
    expect(resizeRect(start, "w", -5, 0).x).toBe(0);
    expect(resizeRect(start, "n", 0, -5).y).toBe(0);
    expect(resizeRect(start, "s", 0, 5).y + resizeRect(start, "s", 0, 5).h).toBeCloseTo(1, 5);
  });
  it("does not flip over the opposite edge", () => {
    const r = resizeRect(start, "e", -5, 0);
    expect(r.w).toBe(MIN_FIELD_W);
    expect(r.x).toBe(0.2);
  });
});

describe("snapping", () => {
  const others: Rect[] = [{ x: 0.3, y: 0.4, w: 0.2, h: 0.05 }];
  const targets = snapTargets(others);
  it("snaps a moved field's left edge to another field's left edge", () => {
    const r = snapMove({ x: 0.302, y: 0.7, w: 0.1, h: 0.05 }, targets, 0.01);
    expect(r.rect.x).toBeCloseTo(0.3, 5);
    expect(r.guideX).toBeCloseTo(0.3, 5);
    expect(r.guideY).toBeNull();
  });
  it("snaps centres and the page edge", () => {
    const centre = snapMove({ x: 0.397, y: 0.7, w: 0.2, h: 0.05 }, snapTargets([]), 0.01);
    expect(centre.rect.x + centre.rect.w / 2).toBeCloseTo(0.5, 5);
    const edge = snapMove({ x: 0.004, y: 0.004, w: 0.2, h: 0.05 }, snapTargets([]), 0.01);
    expect(edge.rect.x).toBe(0);
    expect(edge.rect.y).toBe(0);
  });
  it("leaves a field alone when nothing is near", () => {
    const r = snapMove({ x: 0.61, y: 0.77, w: 0.1, h: 0.05 }, targets, 0.005);
    expect(r.rect).toEqual({ x: 0.61, y: 0.77, w: 0.1, h: 0.05 });
    expect(r.guideX).toBeNull();
    expect(r.guideY).toBeNull();
  });
  it("snaps only the edge a resize handle moves", () => {
    const r = snapResize({ x: 0.1, y: 0.1, w: 0.202, h: 0.05 }, "e", targets, 0.01);
    expect(r.rect.x).toBeCloseTo(0.1, 5);
    expect(r.rect.x + r.rect.w).toBeCloseTo(0.3, 5);
    expect(r.rect.h).toBeCloseTo(0.05, 5);
  });
  it("refuses a snap that would shrink below the minimum", () => {
    const r = snapResize({ x: 0.1, y: 0.1, w: 0.205, h: 0.05 }, "e", snapTargets([{ x: 0.1, y: 0.5, w: 0.005, h: 0.01 }]), 0.3);
    expect(r.rect.w).toBeGreaterThanOrEqual(MIN_FIELD_W);
  });
});

describe("nudge", () => {
  const page = { width: 600, height: 800 };
  it("moves one point, or ten with shift, at any zoom", () => {
    const r: Rect = { x: 0.5, y: 0.5, w: 0.1, h: 0.05 };
    expect(nudgeRect(r, "right", false, page).x).toBeCloseTo(0.5 + 1 / 600, 5);
    expect(nudgeRect(r, "down", true, page).y).toBeCloseTo(0.5 + 10 / 800, 5);
    expect(nudgeRect(r, "left", false, page).x).toBeCloseTo(0.5 - 1 / 600, 5);
    expect(nudgeRect(r, "up", true, page).y).toBeCloseTo(0.5 - 10 / 800, 5);
  });
  it("stops at the edge", () => {
    expect(nudgeRect({ x: 0, y: 0, w: 0.1, h: 0.1 }, "left", true, page).x).toBe(0);
    expect(nudgeRect({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, "down", true, page).y).toBe(0.9);
  });
  it("resizes from the keyboard", () => {
    const r: Rect = { x: 0.1, y: 0.1, w: 0.2, h: 0.1 };
    const wider = nudgeSize(r, "right", true, page);
    expect(wider.w).toBeCloseTo(0.2 + 10 / 600, 5);
    expect(wider.x).toBe(0.1);
    expect(nudgeSize(r, "up", false, page).h).toBeCloseTo(0.1 - 1 / 800, 5);
  });
});

describe("default sizes and new fields", () => {
  it("gives every type a size that fits the page and passes the rules", () => {
    for (const type of FIELD_TYPES) {
      for (const aspect of [0.7, 1, 1.4142, 2]) {
        const { w, h } = defaultSize(type, aspect);
        expect(w).toBeGreaterThanOrEqual(MIN_FIELD_W);
        expect(h).toBeGreaterThanOrEqual(0.005);
        expect(w).toBeLessThan(0.5);
        expect(h).toBeLessThan(0.5);
      }
    }
  });
  it("makes a checkbox square on the page", () => {
    const aspect = 1.4142;
    const { w, h } = defaultSize("checkbox", aspect);
    expect(w).toBeCloseTo(h * aspect, 3);
  });
  it("centres a click and keeps the field inside the page", () => {
    const mid = rectAtPoint("signature", 1.4142, { x: 0.5, y: 0.5 });
    expect(mid.x + mid.w / 2).toBeCloseTo(0.5, 3);
    const corner = rectAtPoint("signature", 1.4142, { x: 1, y: 1 });
    expect(corner.x + corner.w).toBeLessThanOrEqual(1);
    expect(corner.y + corner.h).toBeLessThanOrEqual(1);
    const origin = rectAtPoint("signature", 1.4142, { x: 0, y: 0 });
    expect(origin.x).toBe(0);
    expect(origin.y).toBe(0);
  });
  it("treats a short drag as a click and a long drag as a drawn box", () => {
    const click = rectForDraw("text", 1.4142, { x: 0.5, y: 0.5 }, { x: 0.501, y: 0.502 }, 0.01);
    expect(click.w).toBe(defaultSize("text", 1.4142).w);
    const drawn = rectForDraw("text", 1.4142, { x: 0.6, y: 0.5 }, { x: 0.3, y: 0.55 }, 0.01);
    expect(drawn).toEqual({ x: 0.3, y: 0.5, w: 0.3, h: 0.05 });
  });
  it("creates a valid field of every type", () => {
    const roles = [signer("a")];
    const taken = new Set<string>();
    const fields: PlacedField[] = [];
    for (const type of FIELD_TYPES) {
      const role = type === "static_text" ? SENDER_ROLE : "a";
      const overrides: Partial<PlacedField> = type === "dropdown" ? { options: ["Yes", "No"] } : type === "static_text" ? { text: "Hello" } : {};
      const f = createField({ type, page: 0, rect: rectAtPoint(type, 1.4142, { x: 0.5, y: 0.5 }), role, taken, overrides });
      taken.add(f.key);
      fields.push(f);
    }
    expect(validateFields(fields, roles, 1)).toEqual([]);
    expect(fields.find((f) => f.type === "checkbox")?.required).toBe(false);
    expect(fields.find((f) => f.type === "signature")?.required).toBe(true);
  });
});

describe("field keys", () => {
  it("satisfies the server pattern and is unique", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const k = newFieldKey(taken);
      expect(KEY_PATTERN.test(k)).toBe(true);
      expect(k.startsWith("f_")).toBe(true);
      expect(taken.has(k)).toBe(false);
      taken.add(k);
    }
  });
  it("never repeats even when the random source is stuck", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 20; i++) taken.add(newFieldKey(taken, () => 0));
    expect(taken.size).toBe(20);
    for (const k of taken) expect(KEY_PATTERN.test(k)).toBe(true);
  });
  it("accepts keys the server accepts", () => {
    const f = createField({ type: "text", page: 0, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, role: "a", taken: new Set() });
    expect(validateFields([f], [signer("a")], 1)).toEqual([]);
  });
});

describe("duplicate, copy to every page, paste", () => {
  it("duplicates with a new key, shifted, and inside the page", () => {
    const f = field({ x: 0.1, y: 0.1 });
    const d = duplicateField(f, keysOf([f]), counter());
    expect(d.key).not.toBe(f.key);
    expect(d.x).toBeGreaterThan(f.x);
    expect(d.y).toBeGreaterThan(f.y);
    const corner = duplicateField(field({ x: 0.8, y: 0.95, w: 0.2, h: 0.05 }), new Set(), counter());
    expect(corner.x + corner.w).toBeLessThanOrEqual(1);
    expect(corner.y + corner.h).toBeLessThanOrEqual(1);
  });
  it("copies a field to every other page at the same spot, once", () => {
    const f = field({ page: 1 });
    const first = copyToPages([f], f, 4, { random: counter() });
    expect(first.added.map((a) => a.page)).toEqual([0, 2, 3]);
    expect(new Set([f.key, ...first.added.map((a) => a.key)]).size).toBe(4);
    for (const a of first.added) expect([a.x, a.y, a.w, a.h]).toEqual([f.x, f.y, f.w, f.h]);
    const again = copyToPages([f, ...first.added], f, 4, { random: counter() });
    expect(again.added).toEqual([]);
    expect(again.skipped).toBe(3);
  });
  it("copies to chosen pages only and ignores bad pages", () => {
    const f = field({ page: 0 });
    const r = copyToPages([f], f, 3, { pages: [0, 2, 9, -1] });
    expect(r.added.map((a) => a.page)).toEqual([2]);
  });
  it("stops at the maximum number of fields", () => {
    const many: PlacedField[] = Array.from({ length: MAX_FIELDS - 1 }, (_, i) => field({ key: `k${i}`, page: 0, x: (i % 50) / 100 }));
    const src = many[0];
    const r = copyToPages(many, src, 5, { random: counter() });
    expect(r.added.length).toBe(1);
  });
  it("pastes with new keys onto a page, shifting repeats on the same page", () => {
    const f = field({ page: 0 });
    const same = pasteFields([f], [f], 0, 1, counter());
    expect(same[0].key).not.toBe(f.key);
    expect(same[0].x).toBeGreaterThan(f.x);
    const other = pasteFields([f], [f], 2, 1, counter());
    expect(other[0].page).toBe(2);
    expect(other[0].x).toBe(f.x);
  });
});

describe("roles", () => {
  it("adds a role with the next free key and colour", () => {
    let roles: SignRole[] = [];
    for (let i = 0; i < MAX_ROLES; i++) {
      const r = addRole(roles, { label: `R${i}`, kind: "signer" });
      expect(r).not.toBeNull();
      roles = r!.roles;
    }
    expect(roles.map((r) => r.key)).toEqual(["role_1", "role_2", "role_3", "role_4", "role_5", "role_6"]);
    expect(roles.map((r) => r.color)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(validateRoles(roles)).toEqual([]);
    expect(addRole(roles, { label: "Too many", kind: "signer" })).toBeNull();
  });
  it("reuses a freed key and colour", () => {
    const roles = [signer("role_1", 0), signer("role_3", 2)];
    expect(nextRoleKey(roles)).toBe("role_2");
    expect(nextRoleColor(roles)).toBe(1);
    expect(nextRoleColor([signer("a", 0), signer("b", 1), signer("c", 2), signer("d", 3), signer("e", 4), signer("f", 5), signer("g", 5)])).toBe(0);
    expect(ROLE_COLOR_COUNT).toBe(6);
  });
  it("never uses the sender key", () => {
    expect(nextRoleKey([])).not.toBe(SENDER_ROLE);
  });
  it("renames, recolours and changes kind", () => {
    const roles = updateRole([signer("a")], "a", { label: "Merchant", color: 9, kind: "filler" });
    expect(roles[0]).toMatchObject({ label: "Merchant", kind: "filler", color: 3 });
    expect(updateRole([signer("a")], "a", { label: "x".repeat(100) })[0].label.length).toBe(60);
  });
  it("deletes a role and moves its fields to another that may own them", () => {
    const roles = [signer("a"), signer("b", 1)];
    const fields = [field({ key: "f_1", role: "a", type: "signature" }), field({ key: "f_2", role: "b" }), field({ key: "f_3", role: SENDER_ROLE, type: "static_text", text: "x" })];
    const r = removeRole(roles, fields, "a", "b");
    expect(r.roles.map((x) => x.key)).toEqual(["b"]);
    expect(r.fields.map((f) => [f.key, f.role])).toEqual([["f_1", "b"], ["f_2", "b"], ["f_3", SENDER_ROLE]]);
    expect(r.moved).toBe(1);
    expect(r.removed).toBe(0);
    expect(validateFields(r.fields, r.roles, 1)).toEqual([]);
  });
  it("removes fields a filler cannot own, and all fields when no role is chosen", () => {
    const roles = [signer("a"), filler("b")];
    const fields = [field({ key: "f_1", role: "a", type: "signature" }), field({ key: "f_2", role: "a", type: "text" })];
    const toFiller = removeRole(roles, fields, "a", "b");
    expect(toFiller.fields.map((f) => f.key)).toEqual(["f_2"]);
    expect(toFiller.removed).toBe(1);
    const dropped = removeRole(roles, fields, "a", null);
    expect(dropped.fields).toEqual([]);
    expect(dropped.removed).toBe(2);
  });
  it("hands a deleted role's merge fields to the sender instead of deleting them", () => {
    const fields = [field({ key: "f_1", role: "a", merge: "name" })];
    const r = removeRole([signer("a")], fields, "a", null);
    expect(r.fields).toHaveLength(1);
    expect(r.fields[0].role).toBe(SENDER_ROLE);
  });
});

describe("which role a field belongs to", () => {
  const roles = [filler("f"), signer("s")];
  it("keeps the preferred role when it may own the type", () => {
    expect(roleForType("text", roles, "f")).toBe("f");
    expect(roleForType("signature", roles, "s")).toBe("s");
  });
  it("falls back to a signer for signing types and to the sender for static text", () => {
    expect(roleForType("signature", roles, "f")).toBe("s");
    expect(roleForType("date_signed", roles, null)).toBe("s");
    expect(roleForType("static_text", roles, "s")).toBe(SENDER_ROLE);
  });
  it("says there is none when no role may own the type", () => {
    expect(roleForType("signature", [filler("f")], "f")).toBe("");
    expect(roleForType("text", [], null)).toBe("");
  });
});

describe("merge keys", () => {
  it("lists the keys in reading order with counts", () => {
    const fields = [
      field({ key: "f_1", merge: "company", page: 1, y: 0.1 }),
      field({ key: "f_2", merge: "name", page: 0, y: 0.5 }),
      field({ key: "f_3", merge: "company", page: 0, y: 0.2 }),
      field({ key: "f_4" }),
    ];
    expect(mergeKeysOf(fields)).toEqual([
      { key: "company", count: 2, firstField: "f_3" },
      { key: "name", count: 1, firstField: "f_2" },
    ]);
  });
  it("makes typed text into a valid key", () => {
    expect(sanitizeKey("12 Company name!")).toBe("Companyname");
    expect(sanitizeKey("a-b c_d")).toBe("abc_d");
    expect(sanitizeKey("x".repeat(80)).length).toBe(40);
    expect(KEY_PATTERN.test(sanitizeKey("my key"))).toBe(true);
  });
  it("suggests an unused key", () => {
    expect(suggestMergeKey([field({ merge: "value_1" }), field({ key: "f_b", merge: "value_2" })])).toBe("value_3");
  });
  it("hands a merge field to the sender and back to a role", () => {
    const roles = [signer("s")];
    const merged = applyMerge(field({ role: "s", required: true }), "company", roles, "s");
    expect(merged).toMatchObject({ merge: "company", role: SENDER_ROLE, required: false });
    expect(validateFields([merged], roles, 1)).toEqual([]);
    const back = applyMerge(merged, undefined, roles, "s");
    expect(back.merge).toBeUndefined();
    expect("merge" in back).toBe(false);
    expect(back.role).toBe("s");
    expect(back.required).toBe(true);
    const staticField = applyMerge(field({ type: "static_text", role: SENDER_ROLE, text: "x", merge: "k" }), undefined, roles);
    expect(staticField.role).toBe(SENDER_ROLE);
  });
  it("knows which types can be filled by the sender", () => {
    expect(canMerge("text")).toBe(true);
    expect(canMerge("static_text")).toBe(true);
    expect(canMerge("signature")).toBe(false);
  });
});

describe("date formats", () => {
  it("agrees with the server on what a format may be", () => {
    for (const format of ["DD MMM YYYY", "D MMMM YYYY", "DD/MM/YYYY", "YY-M-D", "DD.MM.YYYY, MMM"]) {
      expect(isValidDateFormat(format)).toBe(true);
      expect(validateFields([field({ type: "date", dateFormat: format })], [signer("a")], 1)).toEqual([]);
    }
    for (const format of ["", "dd/mm/yyyy", "DD MMM YYYY HH:mm", "x".repeat(31), "DD<>YYYY"]) {
      expect(isValidDateFormat(format)).toBe(false);
    }
    expect(validateFields([field({ type: "date", dateFormat: "DD<>YYYY" })], [signer("a")], 1).map((i) => i.code)).toContain("bad_date_format");
  });
});

describe("issue messages", () => {
  const source = readFileSync(join(__dirname, "..", "rules.ts"), "utf8");
  const layoutRules = source.slice(source.indexOf("export function validateRoles"), source.indexOf("// ---- answers"));
  const codesInRules = [...layoutRules.matchAll(/code: "([a-z_]+)"/g)].map((m) => m[1]);

  it("words every code validateRoles and validateFields can report", () => {
    expect(codesInRules.length).toBeGreaterThan(15);
    for (const code of new Set(codesInRules)) {
      expect(ISSUE_CODES as readonly string[], `missing issue code ${code}`).toContain(code);
      expect(issueMessageKey(code)).toBe(`issues.${code}`);
    }
  });
  it("lists no code the rules do not produce", () => {
    for (const code of ISSUE_CODES) expect(codesInRules, `stale issue code ${code}`).toContain(code);
  });
  it("falls back for an unknown code", () => {
    expect(issueMessageKey("something_new")).toBe("issues.unknown");
    expect(errorMessageKey("something_new")).toBe("errors.generic");
    expect(errorMessageKey("template_not_ready")).toBe("errors.template_not_ready");
    expect(ERROR_CODES).toContain("invalid_layout");
  });
});

describe("types of fields", () => {
  it("has a default size for every field type", () => {
    for (const type of FIELD_TYPES as readonly FieldType[]) expect(defaultSize(type, 1.4)).toBeTruthy();
  });
});
