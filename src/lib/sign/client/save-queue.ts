// ============================================================
// Doc Sign editor: autosave as a small state machine (no React). The newest value waits `delay` ms after the
// last change, then is sent; one send at a time; a change made while a send is running is sent right after.
// A failed send never loses the value: it is kept and tried again (after 3, 8, then 20 seconds) when the
// failure may pass (network, server, rate limit), and waits for the next change or a manual retry when it will
// not (the server said the layout is not valid, or the document is no longer a draft).
// ============================================================

export type SaveState =
  | { kind: "idle" }
  /** Changed, not sent yet. */
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; code: string; willRetry: boolean };

export interface SaveQueueOptions<T> {
  send: (value: T) => Promise<unknown>;
  onState: (state: SaveState) => void;
  delay?: number;
  retryDelays?: readonly number[];
  /** Can this failure pass by itself? Default: only a network failure or a 5xx or 429 status. */
  isRetryable?: (error: unknown) => boolean;
  codeOf?: (error: unknown) => string;
}

/** A SignApiError-shaped failure (`status` and `code`), read without importing it. */
function shapeOf(error: unknown): { status: number; code: string } {
  const e = error as { status?: unknown; code?: unknown } | null;
  return { status: typeof e?.status === "number" ? e.status : 0, code: typeof e?.code === "string" ? e.code : "request_failed" };
}

export const defaultIsRetryable = (error: unknown): boolean => {
  const { status } = shapeOf(error);
  return status === 0 || status === 429 || status >= 500;
};
export const defaultCodeOf = (error: unknown): string => shapeOf(error).code;

export class SaveQueue<T> {
  private pending: { value: T } | null = null;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private disposed = false;
  private readonly delay: number;
  private readonly retryDelays: readonly number[];

  constructor(private readonly options: SaveQueueOptions<T>) {
    this.delay = options.delay ?? 800;
    this.retryDelays = options.retryDelays ?? [3000, 8000, 20000];
  }

  /** Is there a change that has not reached the server? */
  get unsaved(): boolean {
    return this.pending !== null || this.inFlight;
  }

  /** A new value to save. Replaces any value still waiting. */
  schedule(value: T): void {
    if (this.disposed) return;
    this.pending = { value };
    this.failures = 0;
    this.options.onState({ kind: "dirty" });
    this.arm(this.delay);
  }

  /** Forget the waiting value (the editor holds something that must not be saved yet). */
  cancel(): void {
    this.pending = null;
    this.clearTimer();
    if (!this.inFlight) this.options.onState({ kind: "idle" });
  }

  /** Send now, without waiting for the delay. Resolves when nothing is waiting any more (or the send failed). */
  async flush(): Promise<void> {
    this.clearTimer();
    await this.run();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  /** Leaving the screen: stop, but still send a value that is waiting (nobody is left to see the outcome). */
  disposeAndSend(): void {
    const item = this.pending;
    const busy = this.inFlight;
    this.dispose();
    if (item && !busy) {
      this.pending = null;
      void Promise.resolve(this.options.send(item.value)).catch(() => {});
    }
  }

  private arm(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    if (this.inFlight || !this.pending || this.disposed) return;
    const item = this.pending;
    this.pending = null;
    this.inFlight = true;
    this.options.onState({ kind: "saving" });
    try {
      await this.options.send(item.value);
    } catch (error) {
      this.inFlight = false;
      // keep the value unless a newer one is already waiting
      if (!this.pending) this.pending = item;
      const retryable = (this.options.isRetryable ?? defaultIsRetryable)(error);
      this.options.onState({ kind: "error", code: (this.options.codeOf ?? defaultCodeOf)(error), willRetry: retryable && this.pending === item });
      if (this.pending === item) {
        if (retryable && !this.disposed) this.arm(this.retryDelays[Math.min(this.failures, this.retryDelays.length - 1)] ?? 20000);
      } else {
        // a newer value arrived during the send: it has its own timer
      }
      this.failures++;
      return;
    }
    this.inFlight = false;
    this.failures = 0;
    if (this.pending) {
      // changed while saving: send the newest straight away
      await this.run();
    } else {
      this.options.onState({ kind: "saved" });
    }
  }
}

/** One state for the screen out of several queues: a problem beats work in progress beats waiting beats done. */
export function combineSaveStates(states: readonly SaveState[]): SaveState {
  const order: SaveState["kind"][] = ["error", "saving", "dirty", "saved", "idle"];
  for (const kind of order) {
    const hit = states.find((s) => s.kind === kind);
    if (hit) return hit;
  }
  return { kind: "idle" };
}
