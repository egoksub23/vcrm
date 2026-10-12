// What a file is, from its first bytes: a PDF, a JPEG or a PNG; null for anything else. Never from the name or the type the browser claims.
// Shared by every upload that accepts those three (Secure Sign's form uploads, Compliance requests' evidence files). Pure.

export type DetectedKind = "pdf" | "jpg" | "png";

export const DETECTED_MIME: Record<DetectedKind, string> = { pdf: "application/pdf", jpg: "image/jpeg", png: "image/png" };

export function detectFileKind(bytes: Uint8Array): DetectedKind | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return "pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return "png";
  return null;
}
