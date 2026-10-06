"use client";

// The editing operations of the field editor on top of a controlled `{ fields, roles }` pair: every change goes
// through `commit`, which records an undo step and tells the parent. The parent must hand the new value back
// as props in the same update (a plain `setState`); a value that arrives from anywhere else (a reload) starts
// a fresh history.

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import {
  canRedo,
  canUndo,
  initHistory,
  isPresent,
  pushState,
  redo as redoHistory,
  undo as undoHistory,
  type EditorState,
  type History,
} from "@/lib/sign/client/editor-history";
import {
  addRole as addRoleTo,
  clampRect,
  copyToPages,
  createField,
  duplicateField,
  keysOf,
  nudgeRect,
  nudgeSize,
  pasteFields,
  removeRole,
  roleForType,
  updateRole,
  type NudgeDirection,
  type Rect,
} from "@/lib/sign/client/layout";
import { createBoundPlacement } from "@/lib/sign/client/form-printing";
import type { DataField } from "@/lib/sign/forms/types";
import type { FieldType, PlacedField } from "@/lib/sign/pdf/types";
import { MAX_FIELDS, SENDER_ROLE } from "@/lib/sign/rules";
import type { SignerKind, SignRole } from "@/lib/sign/types";

/** Wording for things the editor creates for the sender, supplied translated. */
export interface EditorSeeds {
  roleLabel: (kind: SignerKind, n: number) => string;
  dropdownOptions: string[];
  staticText: string;
}

export interface EditorModelInput {
  fields: PlacedField[];
  roles: SignRole[];
  onChange: (next: EditorState) => void;
  seeds: EditorSeeds;
}

export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

export interface PlaceOptions {
  type: FieldType;
  page: number;
  rect: Rect;
  /** The role the sender is placing for. */
  preferredRole: string | null;
}

export function useEditorModel({ fields, roles, onChange, seeds }: EditorModelInput) {
  const [history, setHistory] = useState<History>(() => initHistory({ fields, roles }));
  const current: EditorState = { fields, roles };
  if (!isPresent(history, current)) setHistory(initHistory(current));

  // what the next change builds on, valid between renders too (two changes in one event)
  const live = useRef<{ state: EditorState; history: History }>({ state: current, history });
  useLayoutEffect(() => {
    live.current = { state: { fields, roles }, history: isPresent(history, { fields, roles }) ? history : initHistory({ fields, roles }) };
  });
  const clipboard = useRef<{ fields: PlacedField[]; round: number }>({ fields: [], round: 0 });

  const commit = useStableCallback((next: EditorState, coalesceKey?: string) => {
    const nextHistory = pushState(live.current.history, next, { coalesceKey });
    if (nextHistory === live.current.history) return;
    live.current = { state: next, history: nextHistory };
    setHistory(nextHistory);
    onChange(next);
  });

  const undo = useStableCallback(() => {
    const h = undoHistory(live.current.history);
    if (h === live.current.history) return;
    live.current = { state: h.present, history: h };
    setHistory(h);
    onChange(h.present);
  });
  const redo = useStableCallback(() => {
    const h = redoHistory(live.current.history);
    if (h === live.current.history) return;
    live.current = { state: h.present, history: h };
    setHistory(h);
    onChange(h.present);
  });

  const state = () => live.current.state;

  const update = useStableCallback((key: string, patch: Partial<PlacedField> | ((f: PlacedField) => PlacedField), coalesceKey?: string) => {
    const { fields: fs, roles: rs } = state();
    let changed = false;
    const nextFields = fs.map((f) => {
      if (f.key !== key) return f;
      const next = typeof patch === "function" ? patch(f) : { ...f, ...patch };
      if (next !== f) changed = true;
      return next;
    });
    if (changed) commit({ fields: nextFields, roles: rs }, coalesceKey);
  });

  const setRect = useStableCallback((key: string, rect: Rect, coalesceKey?: string) => {
    const r = clampRect(rect);
    update(key, (f) => (f.x === r.x && f.y === r.y && f.w === r.w && f.h === r.h ? f : { ...f, ...r }), coalesceKey);
  });

  const nudge = useStableCallback((key: string, direction: NudgeDirection, big: boolean, page: { width: number; height: number }, resize: boolean) => {
    const f = state().fields.find((x) => x.key === key);
    if (!f) return;
    setRect(key, (resize ? nudgeSize : nudgeRect)(f, direction, big, page), `nudge:${key}`);
  });

  /** Place a new field. Adds a first role when there is none that may own the type. Returns the new key, or null at the maximum. */
  const place = useStableCallback((input: PlaceOptions): string | null => {
    const { fields: fs, roles: rs } = state();
    if (fs.length >= MAX_FIELDS) return null;
    let nextRoles = rs;
    let role = roleForType(input.type, rs, input.preferredRole);
    if (!role && input.type !== "static_text") {
      const kind: SignerKind = "signer";
      const added = addRoleTo(rs, { label: seeds.roleLabel(kind, rs.length + 1), kind });
      if (!added) return null;
      nextRoles = added.roles;
      role = added.role.key;
    }
    const overrides: Partial<PlacedField> =
      input.type === "dropdown" ? { options: [...seeds.dropdownOptions] } : input.type === "static_text" ? { text: seeds.staticText } : {};
    const field = createField({ type: input.type, page: input.page, rect: input.rect, role: input.type === "static_text" ? SENDER_ROLE : role, taken: keysOf(fs), overrides });
    commit({ fields: [...fs, field], roles: nextRoles });
    return field.key;
  });

  /**
   * Forms: place a field that prints a data field's answer, already bound (it belongs to the sender and asks nothing of a signer).
   * `centre` is where its middle goes, as fractions of the page; `avoid` are keys it must not take (the form's data field keys).
   * Returns the new key, or null at the maximum or for a data field that cannot be printed (a file).
   */
  const placeBound = useStableCallback((input: { field: DataField; page: number; centre: { x: number; y: number }; aspect: number; dataValue?: string; avoid?: ReadonlySet<string> }): string | null => {
    const { fields: fs, roles: rs } = state();
    if (fs.length >= MAX_FIELDS) return null;
    const taken = keysOf(fs);
    for (const k of input.avoid ?? []) taken.add(k);
    const placement = createBoundPlacement({ field: input.field, page: input.page, centre: input.centre, aspect: input.aspect, taken, dataValue: input.dataValue });
    if (!placement) return null;
    commit({ fields: [...fs, placement], roles: rs });
    return placement.key;
  });

  const remove = useStableCallback((keys: readonly string[]) => {
    if (keys.length === 0) return;
    const drop = new Set(keys);
    const { fields: fs, roles: rs } = state();
    commit({ fields: fs.filter((f) => !drop.has(f.key)), roles: rs });
  });

  const duplicate = useStableCallback((key: string): string | null => {
    const { fields: fs, roles: rs } = state();
    const f = fs.find((x) => x.key === key);
    if (!f || fs.length >= MAX_FIELDS) return null;
    const copy = duplicateField(f, keysOf(fs));
    commit({ fields: [...fs, copy], roles: rs });
    return copy.key;
  });

  const copyToEveryPage = useStableCallback((key: string, pageCount: number): { added: number; skipped: number } => {
    const { fields: fs, roles: rs } = state();
    const f = fs.find((x) => x.key === key);
    if (!f) return { added: 0, skipped: 0 };
    const { added, skipped } = copyToPages(fs, f, pageCount);
    if (added.length) commit({ fields: [...fs, ...added], roles: rs });
    return { added: added.length, skipped };
  });

  const copy = useStableCallback((key: string) => {
    const f = state().fields.find((x) => x.key === key);
    if (f) clipboard.current = { fields: [f], round: 0 };
  });
  const hasClipboard = () => clipboard.current.fields.length > 0;
  const paste = useStableCallback((page: number): string | null => {
    if (clipboard.current.fields.length === 0) return null;
    const { fields: fs, roles: rs } = state();
    clipboard.current.round += 1;
    const added = pasteFields(clipboard.current.fields, fs, page, clipboard.current.round);
    if (added.length === 0) return null;
    commit({ fields: [...fs, ...added], roles: rs });
    return added[added.length - 1].key;
  });

  const addRole = useStableCallback((kind: SignerKind): SignRole | null => {
    const { fields: fs, roles: rs } = state();
    const added = addRoleTo(rs, { label: seeds.roleLabel(kind, rs.length + 1), kind });
    if (!added) return null;
    commit({ fields: fs, roles: added.roles });
    return added.role;
  });
  const patchRole = useStableCallback((key: string, patch: Partial<Pick<SignRole, "label" | "kind" | "color">>) => {
    const { fields: fs, roles: rs } = state();
    commit({ fields: fs, roles: updateRole(rs, key, patch) }, patch.label !== undefined ? `role:${key}:label` : undefined);
  });
  const deleteRole = useStableCallback((key: string, reassignTo: string | null) => {
    const { fields: fs, roles: rs } = state();
    const r = removeRole(rs, fs, key, reassignTo);
    commit({ fields: r.fields, roles: r.roles });
  });

  return {
    fields,
    roles,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    undo,
    redo,
    update,
    setRect,
    nudge,
    place,
    placeBound,
    remove,
    duplicate,
    copyToEveryPage,
    copy,
    hasClipboard,
    paste,
    addRole,
    patchRole,
    deleteRole,
  };
}

export type EditorModel = ReturnType<typeof useEditorModel>;
