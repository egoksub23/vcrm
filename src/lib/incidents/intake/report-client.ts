// The parts of the hosted report page that are plain logic: drafts that survive a refresh or a dropped connection, the messages sent to the page that
// frames the report, and which answers belong to which step. Kept out of the component so each can be tested.

import { validateAnswers, visibleFields, type Answers, type FormSchema, type FormStep, type RosterEntry } from "./form-schema";

// ---- drafts -----------------------------------------------------------------------------------------------------

/** Minimal storage so the page works when localStorage is blocked (a web view with storage off, a private window): it falls back to memory. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function memoryStorage(): DraftStorage {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

/** The browser's storage when it works, memory when it throws or is missing. */
export function pickStorage(candidate: () => DraftStorage | null | undefined): DraftStorage {
  try {
    const s = candidate();
    if (!s) return memoryStorage();
    const probe = "__halo_probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return memoryStorage();
  }
}

/** One draft per report link. Keyed by the link's session, never by anything about a child. */
export function draftKey(token: string): string {
  return `halo-report:${token.slice(0, 40)}`;
}

export interface Draft {
  answers: Answers;
  step: number;
  /** A report the coach tried to send while offline: sent again when the connection returns. */
  pending: boolean;
}

export function saveDraft(storage: DraftStorage, token: string, draft: Draft): void {
  try {
    storage.setItem(draftKey(token), JSON.stringify(draft));
  } catch {
    // Storage full or blocked after the probe: the page still works, the draft is just not kept.
  }
}

export function loadDraft(storage: DraftStorage, token: string): Draft | null {
  try {
    const raw = storage.getItem(draftKey(token));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    if (typeof parsed.answers !== "object" || parsed.answers === null || Array.isArray(parsed.answers)) return null;
    return { answers: parsed.answers as Answers, step: Number.isInteger(parsed.step) ? (parsed.step as number) : 0, pending: parsed.pending === true };
  } catch {
    return null;
  }
}

export function clearDraft(storage: DraftStorage, token: string): void {
  try {
    storage.removeItem(draftKey(token));
  } catch {
    // nothing to do
  }
}

// ---- messages to the page that frames the report ----------------------------------------------------------------

export type ParentMessage =
  | { source: "halo-incident"; type: "ready" }
  | { source: "halo-incident"; type: "resize"; height: number }
  | { source: "halo-incident"; type: "submitted"; reference: string }
  | { source: "halo-incident"; type: "error"; code: string };

/** The message bodies carry no names, no answers and no student ids: only what the portal needs to size the frame and close it. */
export const parentMessage = {
  ready: (): ParentMessage => ({ source: "halo-incident", type: "ready" }),
  resize: (height: number): ParentMessage => ({ source: "halo-incident", type: "resize", height: Math.max(0, Math.round(height)) }),
  submitted: (reference: string): ParentMessage => ({ source: "halo-incident", type: "submitted", reference }),
  error: (code: string): ParentMessage => ({ source: "halo-incident", type: "error", code }),
};

/**
 * Send a message to the framing page, once per registered origin (never "*": an unregistered page that somehow framed the report would receive
 * nothing). Does nothing when the report is not in a frame.
 */
export function notifyParent(win: { parent: unknown; postMessage?: unknown } & object, self: object, origins: readonly string[], message: ParentMessage): number {
  if (win.parent === self || !win.parent) return 0;
  let sent = 0;
  for (const origin of origins) {
    try {
      (win.parent as { postMessage: (m: unknown, target: string) => void }).postMessage(message, origin);
      sent += 1;
    } catch {
      // a closed or cross-origin-blocked parent: ignore
    }
  }
  return sent;
}

// ---- steps ------------------------------------------------------------------------------------------------------

/** Problems with the answers on one step only, so the coach is not told about a later screen. */
export function stepProblems(schema: FormSchema, step: FormStep, answers: Answers, roster: readonly RosterEntry[]): Record<string, string> {
  const all = validateAnswers(schema, answers, roster);
  const keys = new Set(visibleFields(step, answers).map((f) => f.key));
  return Object.fromEntries(Object.entries(all).filter(([k]) => keys.has(k)));
}

/** The first step with a problem, for jumping back after the server finds one. */
export function firstStepWithProblem(schema: FormSchema, problems: Record<string, string>): number {
  const idx = schema.steps.findIndex((s) => s.fields.some((f) => problems[f.key]));
  return idx < 0 ? 0 : idx;
}
