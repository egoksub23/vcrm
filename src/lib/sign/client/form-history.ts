// ============================================================
// Doc Sign form builder: undo and redo as a plain history stack (pure). Same idea as the placement editor's
// (editor-history.ts) but for any state: many small edits of one thing in a row (typing a label) merge into
// one step when they share a `coalesceKey` and come within a second of each other.
// ============================================================

export interface Hist<T> {
  past: T[];
  present: T;
  future: T[];
  lastKey: string | null;
  lastAt: number;
}

export const HIST_LIMIT = 100;
export const HIST_COALESCE_MS = 1000;

export const initHist = <T>(present: T): Hist<T> => ({ past: [], present, future: [], lastKey: null, lastAt: 0 });

export function pushHist<T>(h: Hist<T>, next: T, options: { coalesceKey?: string; now?: number } = {}): Hist<T> {
  if (Object.is(h.present, next)) return h;
  const now = options.now ?? Date.now();
  const key = options.coalesceKey ?? null;
  if (key !== null && h.lastKey === key && now - h.lastAt < HIST_COALESCE_MS && h.past.length > 0) {
    return { ...h, present: next, future: [], lastAt: now };
  }
  const past = [...h.past, h.present];
  if (past.length > HIST_LIMIT) past.splice(0, past.length - HIST_LIMIT);
  return { past, present: next, future: [], lastKey: key, lastAt: now };
}

export const canUndoHist = <T>(h: Hist<T>): boolean => h.past.length > 0;
export const canRedoHist = <T>(h: Hist<T>): boolean => h.future.length > 0;

export function undoHist<T>(h: Hist<T>): Hist<T> {
  if (h.past.length === 0) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], lastKey: null, lastAt: 0 };
}

export function redoHist<T>(h: Hist<T>): Hist<T> {
  if (h.future.length === 0) return h;
  const [present, ...future] = h.future;
  return { past: [...h.past, h.present], present, future, lastKey: null, lastAt: 0 };
}
