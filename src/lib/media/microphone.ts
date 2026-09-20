// Microphone selection for voice notes. The browser's default input is often
// the wrong one on a multi-monitor desk (a monitor's speaker/HDMI input, a
// virtual device), which records silence. So the agent can pick the input,
// the choice is remembered, and a silent take is flagged while recording.

const STORAGE_KEY = "vircle.voiceNote.micId";

/** A silent take reads well under this (peak deviation from centre, 0..1). */
export const SILENCE_THRESHOLD = 0.015;

export interface MicrophoneOption {
  id: string;
  label: string;
}

export function readSavedMicrophone(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveMicrophone(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private mode / blocked storage: the choice just isn't remembered.
  }
}

/**
 * Opens the chosen microphone. A remembered device that has since been
 * unplugged falls back to the browser default instead of failing.
 */
export async function openMicrophone(deviceId?: string | null): Promise<MediaStream> {
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name !== "OverconstrainedError" && name !== "NotFoundError") throw err;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: true });
}

/** Audio inputs. Labels are only filled in once microphone access is granted. */
export async function listMicrophones(): Promise<MicrophoneOption[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput" && d.deviceId)
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

/** The device the stream is actually using. */
export function activeMicrophoneId(stream: MediaStream): string | null {
  return stream.getAudioTracks()[0]?.getSettings().deviceId ?? null;
}

/** Loudest sample in the analyser's window, 0 (silence) .. 1 (clipping). */
export function readPeakLevel(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buffer);
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    const deviation = Math.abs(buffer[i] - 128) / 128;
    if (deviation > peak) peak = deviation;
  }
  return peak;
}
