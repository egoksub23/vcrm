"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

/**
 * Save after the person pauses. The caller keeps its latest value in a ref and `save` reads it, so a save
 * always sends what is on screen now. `touch()` says "something changed, save soon"; `flush()` saves at
 * once if anything is waiting (leaving a step, pressing Send) and resolves true when nothing is left unsaved.
 * A failed save leaves the change waiting: `touch()` or `flush()` tries again.
 */
export function useAutosave(save: () => Promise<void>, delayMs = 800) {
  const [state, setState] = useState<SaveState>("idle");
  const saveRef = useRef(save);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const running = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    saveRef.current = save;
  });

  const run = useCallback((): Promise<boolean> => {
    if (running.current) return running.current;
    const job = (async () => {
      let ok = true;
      // a change made while saving is saved right after, in the same run
      while (dirty.current) {
        dirty.current = false;
        setState("saving");
        try {
          await saveRef.current();
        } catch {
          dirty.current = true;
          ok = false;
          break;
        }
      }
      setState(ok ? "saved" : "error");
      return ok;
    })();
    running.current = job;
    void job.finally(() => {
      running.current = null;
    });
    return job;
  }, []);

  const touch = useCallback(() => {
    dirty.current = true;
    setState((s) => (s === "saving" ? s : "pending"));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void run();
    }, delayMs);
  }, [delayMs, run]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (running.current) await running.current;
    if (!dirty.current) return true;
    return run();
  }, [run]);

  // leaving the page saves what is waiting
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (dirty.current) void saveRef.current().catch(() => {});
    },
    [],
  );

  return { state, touch, flush };
}

/** The one state to show for several saves: a failure outranks work in progress, which outranks saved. */
export function combineSaveStates(states: readonly SaveState[]): SaveState {
  if (states.includes("error")) return "error";
  if (states.includes("saving")) return "saving";
  if (states.includes("pending")) return "pending";
  if (states.includes("saved")) return "saved";
  return "idle";
}
