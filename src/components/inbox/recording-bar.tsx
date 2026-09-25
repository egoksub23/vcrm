"use client";

import { useEffect, useRef, useState } from "react";
import { Square, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  readPeakLevel,
  SILENCE_THRESHOLD,
  type MicrophoneOption,
} from "@/lib/media/microphone";

/** Seconds of no sound before the "check your microphone" warning shows. */
const SILENT_WARNING_SECONDS = 2;

interface RecordingBarProps {
  analyser: AnalyserNode | null;
  elapsed: string;
  max: string;
  seconds: number;
  devices: MicrophoneOption[];
  deviceId: string | null;
  onSwitchDevice: (id: string) => void;
  onCancel: () => void;
  onStop: () => void;
  /** Caller's own translator — Inbox and Sembang each keep their own copy
   *  of these strings under their own i18n namespace. */
  t: (key: string, values?: Record<string, string | number>) => string;
}

// Replaces the composer while the mic is live. The level meter is polled here
// (not in the composer) so ten updates a second don't re-render the inbox.
export function RecordingBar({
  analyser,
  elapsed,
  max,
  seconds,
  devices,
  deviceId,
  onSwitchDevice,
  onCancel,
  onStop,
  t,
}: RecordingBarProps) {
  const [level, setLevel] = useState(0);
  const [heardSound, setHeardSound] = useState(false);
  const heardRef = useRef(false);

  useEffect(() => {
    // The bar mounts fresh for every take (and every microphone switch), so
    // the state starts clean.
    if (!analyser) return;
    const buffer = new Uint8Array(analyser.fftSize);
    const timer = setInterval(() => {
      const peak = readPeakLevel(analyser, buffer);
      setLevel(Math.min(1, peak * 2.5));
      if (!heardRef.current && peak > SILENCE_THRESHOLD) {
        heardRef.current = true;
        setHeardSound(true);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [analyser]);

  const silent = !heardSound && seconds >= SILENT_WARNING_SECONDS;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted px-4 py-2.5">
      <div className="flex items-center gap-3">
        <span className="flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
        <span className="text-sm text-foreground">
          {t("recording", { current: elapsed, max })}
        </span>
        <div
          className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-border"
          role="meter"
          aria-label={t("micLevel")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
        >
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width] duration-100"
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-card hover:text-foreground"
        >
          {t("cancel")}
        </button>
        <Button
          size="sm"
          onClick={onStop}
          className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90"
          title={t("stopAndAttach")}
        >
          <Square className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {devices.length > 0 && (
          <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">{t("microphone")}</span>
            <select
              value={deviceId ?? ""}
              onChange={(e) => onSwitchDevice(e.target.value)}
              className="min-w-0 max-w-64 truncate rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
            >
              {deviceId === null && <option value="" disabled />}
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {silent && (
          <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            {t("noSoundDetected")}
          </span>
        )}
      </div>
    </div>
  );
}
