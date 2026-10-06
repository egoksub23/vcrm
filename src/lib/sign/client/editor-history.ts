// ============================================================
// Doc Sign editor: undo and redo as a plain history stack (pure). A state is the fields and roles together,
// so undoing "delete this role" brings back its fields too. Many small edits of one thing in a row (typing
// in a label, arrow-key nudges) are merged into one step when they share a `coalesceKey` and come within a
// second of each other.
// ============================================================

import type { PlacedField } from "../pdf/types";
import type { SignRole } from "../types";

export interface EditorState {
  fields: PlacedField[];
  roles: SignRole[];
}

export interface History {
  past: EditorState[];
  present: EditorState;
  future: EditorState[];
  lastKey: string | null;
  lastAt: number;
}

export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 1000;

export function initHistory(state: EditorState): History {
  return { past: [], present: state, future: [], lastKey: null, lastAt: 0 };
}

/** Is `state` exactly what the history holds now (same arrays)? The editor uses this to notice a change from outside. */
export const isPresent = (h: History, state: EditorState): boolean => h.present.fields === state.fields && h.present.roles === state.roles;

export function pushState(h: History, next: EditorState, options: { coalesceKey?: string; now?: number } = {}): History {
  if (isPresent(h, next)) return h;
  const now = options.now ?? Date.now();
  const key = options.coalesceKey ?? null;
  if (key !== null && h.lastKey === key && now - h.lastAt < COALESCE_MS && h.past.length > 0) {
    return { ...h, present: next, future: [], lastAt: now };
  }
  const past = [...h.past, h.present];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, present: next, future: [], lastKey: key, lastAt: now };
}

export const canUndo = (h: History): boolean => h.past.length > 0;
export const canRedo = (h: History): boolean => h.future.length > 0;

export function undo(h: History): History {
  if (h.past.length === 0) return h;
  const present = h.past[h.past.length - 1];
  return { past: h.past.slice(0, -1), present, future: [h.present, ...h.future], lastKey: null, lastAt: 0 };
}

export function redo(h: History): History {
  if (h.future.length === 0) return h;
  const [present, ...future] = h.future;
  return { past: [...h.past, h.present], present, future, lastKey: null, lastAt: 0 };
}
