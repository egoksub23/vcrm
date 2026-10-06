// ============================================================
// The verify page compares the file a person holds with the signed original by fingerprint (SHA-256),
// worked out in their own browser: the file is never uploaded. Web Crypto only exists on secure pages
// (https and localhost), which the verify page always is; anywhere else this reports that it cannot.
// ============================================================

export class HashUnavailableError extends Error {
  constructor() {
    super("This browser cannot compute a file fingerprint.");
    this.name = "HashUnavailableError";
  }
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 of a file's bytes, as 64 lowercase hex characters. */
export async function sha256OfFile(file: Blob): Promise<string> {
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (!subtle) throw new HashUnavailableError();
  return hex(new Uint8Array(await subtle.digest("SHA-256", await file.arrayBuffer())));
}

export type CopyCheck = "match" | "different";

/** Is the fingerprint of the copy the person holds the same as the signed original's? Case does not matter. */
export function compareFingerprints(held: string, original: string): CopyCheck {
  return held.trim().toLowerCase() === original.trim().toLowerCase() ? "match" : "different";
}
