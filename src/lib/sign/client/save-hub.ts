// ============================================================
// Secure Sign, step 3: saving the blocks of SEVERAL documents (no React). Each document keeps saving to its own document through its own
// SaveQueue (debounced, one send at a time, retried), a layout queue for the blocks and a values queue for the merge values; the hub is the
// one place that routes a change to the right document's queue, tells the screen each document's state, and flushes them all when the sender
// leaves the step.
// ============================================================

import { SaveQueue, combineSaveStates, type SaveState } from "./save-queue";

export type SaveKind = "layout" | "values";

export interface SaveHubOptions<L, V> {
  sendLayout: (docId: string, value: L) => Promise<unknown>;
  sendValues: (docId: string, value: V) => Promise<unknown>;
  /** One document's state changed (its two queues combined). */
  onState: (docId: string, state: SaveState) => void;
  delay?: number;
  retryDelays?: readonly number[];
}

interface Entry<L, V> {
  layout: SaveQueue<L>;
  values: SaveQueue<V>;
  states: { layout: SaveState; values: SaveState };
}

export class SaveHub<L, V> {
  private readonly entries = new Map<string, Entry<L, V>>();
  private disposed = false;

  constructor(private readonly options: SaveHubOptions<L, V>) {}

  private entry(docId: string): Entry<L, V> {
    const have = this.entries.get(docId);
    if (have) return have;
    const states = { layout: { kind: "idle" } as SaveState, values: { kind: "idle" } as SaveState };
    const report = (kind: SaveKind) => (s: SaveState) => {
      states[kind] = s;
      this.options.onState(docId, combineSaveStates([states.layout, states.values]));
    };
    const common = { delay: this.options.delay, retryDelays: this.options.retryDelays };
    const entry: Entry<L, V> = {
      layout: new SaveQueue<L>({ ...common, send: (v) => this.options.sendLayout(docId, v), onState: report("layout") }),
      values: new SaveQueue<V>({ ...common, send: (v) => this.options.sendValues(docId, v), onState: report("values") }),
      states,
    };
    this.entries.set(docId, entry);
    return entry;
  }

  /** A change to a document's blocks (layout) or merge values: waits its turn in THAT document's queue only. */
  scheduleLayout(docId: string, value: L): void {
    if (!this.disposed) this.entry(docId).layout.schedule(value);
  }
  scheduleValues(docId: string, value: V): void {
    if (!this.disposed) this.entry(docId).values.schedule(value);
  }
  /** A layout the server would refuse stays on the screen: forget what waits for that document. */
  cancelLayout(docId: string): void {
    this.entries.get(docId)?.layout.cancel();
  }

  /** The state of one document's saving (idle for one never changed). */
  stateOf(docId: string): SaveState {
    const e = this.entries.get(docId);
    return e ? combineSaveStates([e.states.layout, e.states.values]) : { kind: "idle" };
  }

  /** The state for the whole step: a problem in any document beats work in progress beats waiting. */
  combined(): SaveState {
    return combineSaveStates([...this.entries.values()].flatMap((e) => [e.states.layout, e.states.values]));
  }

  /** The documents with a change that has not reached the server. */
  unsavedDocs(): string[] {
    return [...this.entries].filter(([, e]) => e.layout.unsaved || e.values.unsaved).map(([id]) => id);
  }

  /** Send what waits, for one document or for all of them at once. True when nothing is left unsaved afterwards. */
  async flush(docId?: string): Promise<boolean> {
    const list = docId ? [this.entries.get(docId)].filter((e): e is Entry<L, V> => !!e) : [...this.entries.values()];
    await Promise.all(list.flatMap((e) => [e.layout.flush(), e.values.flush()]));
    return list.every((e) => !e.layout.unsaved && !e.values.unsaved);
  }

  /** Leaving the screen: stop the timers but still send what waits, in every document. */
  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) {
      e.layout.disposeAndSend();
      e.values.disposeAndSend();
    }
  }
}
