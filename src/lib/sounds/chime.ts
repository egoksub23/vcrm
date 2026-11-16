"use client";

// Synthesize a short notification chime using the Web Audio API.
// No audio file needed — works offline, tiny bundle cost.
//
// Browser autoplay policy: audio only works after the user has interacted
// with the page at least once. Silent failures are intentional — never
// throw or toast on a blocked chime.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  return ctx;
}

function tone(
  ac: AudioContext,
  freq: number,
  startAt: number,
  duration: number,
  gain: number,
) {
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, startAt);
  env.gain.setValueAtTime(0, startAt);
  env.gain.linearRampToValueAtTime(gain, startAt + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(env);
  env.connect(ac.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.05);
}

// Two-note ascending chime: C5 → E5, soft and brief.
export function playChime(): void {
  const ac = getCtx();
  if (!ac) return;
  try {
    if (ac.state === "suspended") {
      void ac.resume();
    }
    const now = ac.currentTime;
    tone(ac, 523.25, now,        0.35, 0.18); // C5
    tone(ac, 659.25, now + 0.12, 0.35, 0.14); // E5
  } catch {
    // blocked by autoplay policy or AudioContext limit — ignore silently
  }
}
