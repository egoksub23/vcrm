"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  activeMicrophoneId,
  listMicrophones,
  openMicrophone,
  readSavedMicrophone,
  saveMicrophone,
  type MicrophoneOption,
} from "@/lib/media/microphone";

/** Worker that encodes mic input to Ogg/Opus entirely in the browser
 *  (vendored from opus-recorder into /public). Recording client-side in a
 *  widely-accepted format means no server-side transcode step. */
const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js";

export type VoiceRecorderErrorKind = "unsupported" | "denied" | "lost" | "tooLong";

export interface UseVoiceRecorderOptions {
  /** Recording is disabled entirely (read-only, channel closed, already busy). */
  disabled?: boolean;
  /** Hard cap in seconds — auto-stops the recorder when reached. */
  maxSeconds: number;
  /** Hard cap in bytes — a take over this is discarded instead of finalized. */
  maxBytes: number;
  /** Called with the finalized Ogg/Opus file once a take completes. An
   *  empty/cancelled take never calls this. */
  onRecorded: (file: File) => void | Promise<void>;
  onError?: (kind: VoiceRecorderErrorKind) => void;
}

export interface UseVoiceRecorderResult {
  recording: boolean;
  recordSeconds: number;
  micAnalyser: AnalyserNode | null;
  micDevices: MicrophoneOption[];
  micDeviceId: string | null;
  start: (micId?: string) => Promise<void>;
  stop: () => void;
  cancel: () => void;
  switchDevice: (id: string) => Promise<void>;
}

/** Records a single voice note as Ogg/Opus, encoded client-side via
 *  opus-recorder. Shared by the Inbox composer and Sembang's composer so
 *  the mic-capture/encode state machine exists in exactly one place. */
export function useVoiceRecorder({
  disabled = false,
  maxSeconds,
  maxBytes,
  onRecorded,
  onError,
}: UseVoiceRecorderOptions): UseVoiceRecorderResult {
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [micAnalyser, setMicAnalyser] = useState<AnalyserNode | null>(null);
  const [micDevices, setMicDevices] = useState<MicrophoneOption[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);

  const recorderRef = useRef<import("opus-recorder").default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The microphone stream and audio graph are opened here (not by the
  // recorder) so the caller can pick the input and show a live level.
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const onRecordedRef = useRef(onRecorded);
  onRecordedRef.current = onRecorded;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Turns the microphone off (the browser's recording indicator goes away).
  const releaseMic = useCallback(() => {
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    void ctx?.close().catch(() => {});
    setMicAnalyser(null);
  }, []);

  const finalize = useCallback(
    async (bytes: Uint8Array) => {
      // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the
      // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
      const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.ogg`, {
        type: "audio/ogg",
      });
      if (file.size === 0) return; // cancelled / empty take
      if (file.size > maxBytes) {
        onErrorRef.current?.("tooLong");
        return;
      }
      await onRecordedRef.current(file);
    },
    [maxBytes],
  );

  // `micId` is a device picked in the recording bar; otherwise the last
  // remembered choice, otherwise the browser default.
  const start = useCallback(
    async (micId?: string) => {
      if (disabled) return;
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
        onErrorRef.current?.("unsupported");
        return;
      }
      try {
        const stream = await openMicrophone(micId ?? readSavedMicrophone());
        micStreamRef.current = stream;
        // If the device is unplugged mid-take, say so instead of sending silence.
        stream.getAudioTracks()[0]?.addEventListener("ended", () => {
          if (micStreamRef.current !== stream) return;
          onErrorRef.current?.("lost");
          cancelledRef.current = true;
          clearTimer();
          setRecording(false);
          void recorderRef.current?.stop().catch(() => {});
          releaseMic();
        });
        // Labels are only readable now that access has been granted.
        setMicDevices(await listMicrophones().catch(() => []));
        setMicDeviceId(activeMicrophoneId(stream));

        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        setMicAnalyser(analyser);

        // Lazy-load the encoder (≈400 KB worker) only when the user records,
        // keeping it out of the main bundle.
        const { default: Recorder } = await import("opus-recorder");
        const recorder = new Recorder({
          encoderPath: OPUS_ENCODER_PATH,
          numberOfChannels: 1,
          encoderApplication: 2048, // VOIP — tuned for speech
          encoderSampleRate: 48000,
          streamPages: false, // one callback with the complete file on stop
          sourceNode: source, // our own stream, so the chosen microphone is used
        });
        cancelledRef.current = false;
        recorder.ondataavailable = (bytes) => {
          if (cancelledRef.current) return;
          void finalize(bytes);
        };
        recorderRef.current = recorder;
        await recorder.start();
        setRecording(true);
        setRecordSeconds(0);
        timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
      } catch {
        void recorderRef.current?.stop().catch(() => {});
        recorderRef.current = null;
        releaseMic();
        onErrorRef.current?.("denied");
      }
    },
    [disabled, clearTimer, releaseMic, finalize],
  );

  const stop = useCallback(() => {
    clearTimer();
    setRecording(false);
    // Turn the mic off once the encoder has flushed the take.
    void (recorderRef.current?.stop().catch(() => {}) ?? Promise.resolve()).finally(releaseMic);
  }, [clearTimer, releaseMic]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setRecording(false);
    void (recorderRef.current?.stop().catch(() => {}) ?? Promise.resolve()).finally(releaseMic);
  }, [clearTimer, releaseMic]);

  // Picking another microphone restarts the take on it (the abandoned take is
  // discarded) and remembers the choice for next time.
  const switchDevice = useCallback(
    async (id: string) => {
      if (!id || id === micDeviceId) return;
      saveMicrophone(id);
      cancelledRef.current = true;
      clearTimer();
      setRecording(false);
      await (recorderRef.current?.stop().catch(() => {}) ?? Promise.resolve());
      releaseMic();
      await start(id);
    },
    [micDeviceId, clearTimer, releaseMic, start],
  );

  // Auto-stop at the cap so a forgotten recording can't blow the
  // upload size limit.
  useEffect(() => {
    if (recording && recordSeconds >= maxSeconds) {
      stop();
    }
  }, [recording, recordSeconds, maxSeconds, stop]);

  // Tear down any live recording + timer on unmount so a mid-record
  // navigation doesn't leak the mic.
  useEffect(() => {
    return () => {
      clearTimer();
      cancelledRef.current = true;
      void recorderRef.current?.stop().catch(() => {});
      releaseMic();
    };
    // clearTimer/releaseMic are stable (empty-dep useCallback) — this only
    // needs to run once, on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    recording,
    recordSeconds,
    micAnalyser,
    micDevices,
    micDeviceId,
    start,
    stop,
    cancel,
    switchDevice,
  };
}
