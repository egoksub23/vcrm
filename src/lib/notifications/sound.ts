/**
 * Audible notification sound — synthesized via Web Audio API so no
 * audio asset file is needed. A short two-tone ding (A5 → C#6) with
 * exponential decay, ~0.5 s total.
 *
 * Rules that match the browser's autoplay policy:
 * - The AudioContext is created lazily on the first play() call, never
 *   at import time. By the time a notification fires the user has
 *   already clicked to sign in, satisfying the user-gesture requirement.
 * - On a suspended context (browser may suspend inactive contexts) we
 *   call resume() before scheduling notes.
 * - All errors are caught; a missing AudioContext never breaks the app.
 */

export const SOUND_NOTIFY_STORAGE_KEY = "wacrm:sound-notifications";
export const SOUND_NOTIFY_CHANGE_EVENT = "wacrm:sound-notifications-change";

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!)();
    } catch {
      return null;
    }
  }
  return ctx;
}

function scheduleNote(
  context: AudioContext,
  frequency: number,
  startAt: number,
  duration: number,
  gain: number,
): void {
  const osc = context.createOscillator();
  const env = context.createGain();
  osc.connect(env);
  env.connect(context.destination);
  osc.type = "sine";
  osc.frequency.value = frequency;
  env.gain.setValueAtTime(gain, startAt);
  env.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
  osc.start(startAt);
  osc.stop(startAt + duration);
}

/** Play the notification ding. Silent on any error. */
export function playNotificationSound(): void {
  const context = getCtx();
  if (!context) return;
  const resume = context.state === "suspended" ? context.resume() : Promise.resolve();
  void resume.then(() => {
    const now = context.currentTime;
    // Two-tone ding: A5 (880 Hz) then C#6 (1109 Hz), 40 ms apart
    scheduleNote(context, 880, now, 0.35, 0.25);
    scheduleNote(context, 1109, now + 0.04, 0.4, 0.2);
  });
}

// -----------------------------------------------------------------------
// localStorage preference (device-scoped, same pattern as browser-notify)
// -----------------------------------------------------------------------

export function readSoundNotifyPref(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SOUND_NOTIFY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSoundNotifyPref(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled) {
      window.localStorage.setItem(SOUND_NOTIFY_STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(SOUND_NOTIFY_STORAGE_KEY);
    }
  } catch {
    // best-effort
  }
  window.dispatchEvent(new Event(SOUND_NOTIFY_CHANGE_EVENT));
}

export function subscribeSoundNotifyPref(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === SOUND_NOTIFY_STORAGE_KEY) onChange();
  };
  window.addEventListener(SOUND_NOTIFY_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SOUND_NOTIFY_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
