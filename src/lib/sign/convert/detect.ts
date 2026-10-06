// ============================================================
// What an uploaded file really is, decided from its bytes and not from its name, and whether it is
// safe to hand to the converter. Uploaded Word files are untrusted: macros are refused outright
// (they never run in the converter, but a macro-carrying document is not one we sign), and a zip
// that expands to far more than it weighs is refused before anything opens it.
// ============================================================

export type UploadKind = "pdf" | "docx" | "doc" | "png" | "jpeg";

export type UploadErrorCode =
  | "upload_empty"
  | "upload_too_large"
  | "upload_unsupported"
  | "upload_name_mismatch"
  | "upload_macros"
  | "upload_zip_bomb"
  | "upload_encrypted_word";

export class UploadError extends Error {
  readonly code: UploadErrorCode;
  constructor(code: UploadErrorCode, message: string) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

export const UPLOAD_ERROR_MESSAGES: Record<UploadErrorCode, string> = {
  upload_empty: "This file is empty.",
  upload_too_large: "This file is larger than 25 MB.",
  upload_unsupported: "Upload a PDF, a Word file (.docx or .doc) or an image (JPG or PNG).",
  upload_name_mismatch: "This file does not match its name. Check that it is a PDF, Word file or image and upload it again.",
  upload_macros: "This Word file contains macros, which are not allowed. Save it as a plain .docx without macros, or as a PDF.",
  upload_zip_bomb: "This file expands to far more than its size and cannot be processed.",
  upload_encrypted_word: "This Word file is password protected. Remove the protection and upload it again.",
};

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** The most a Word file's contents may expand to when unzipped. A real document is a tiny fraction of this. */
export const MAX_DOCX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
export const MAX_DOCX_ENTRIES = 5000;

export const MIME_FOR_KIND: Record<UploadKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  png: "image/png",
  jpeg: "image/jpeg",
};

const hasPrefix = (b: Uint8Array, sig: number[]) => b.length >= sig.length && sig.every((v, i) => b[i] === v);

/** The kind of file these bytes are, or null. */
export function sniffKind(bytes: Uint8Array): UploadKind | null {
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (head.includes("%PDF-")) return "pdf";
  if (hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) || hasPrefix(bytes, [0x50, 0x4b, 0x05, 0x06])) return "docx"; // zip: checked further below
  if (hasPrefix(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "doc"; // OLE2 container
  return null;
}

const EXTENSIONS: Record<string, UploadKind> = {
  pdf: "pdf",
  docx: "docx",
  doc: "doc",
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
};

/** The kind a file name claims, or null. */
export function kindFromName(name: string): UploadKind | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name.trim())?.[1]?.toLowerCase();
  return ext ? (EXTENSIONS[ext] ?? null) : null;
}

interface ZipEntry {
  name: string;
  compressed: number;
  uncompressed: number;
}

/** The entries of a zip, read from its central directory without unpacking anything. Null if it is not a readable zip. */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory record: signature 0x06054b50, within the last 65557 bytes
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let offset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) return null; // zip64: not expected for a document
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (offset + 46 > bytes.length || dv.getUint32(offset, true) !== 0x02014b50) return null;
    const compressed = dv.getUint32(offset + 20, true);
    const uncompressed = dv.getUint32(offset + 24, true);
    const nameLen = dv.getUint16(offset + 28, true);
    const extraLen = dv.getUint16(offset + 30, true);
    const commentLen = dv.getUint16(offset + 32, true);
    if (offset + 46 + nameLen > bytes.length) return null;
    const name = Buffer.from(bytes.subarray(offset + 46, offset + 46 + nameLen)).toString("utf8");
    entries.push({ name, compressed, uncompressed });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Decide what an upload is and refuse what cannot be accepted. The name is checked against the
 * bytes; a Word file is checked for macros, encryption and zip tricks.
 */
export function classifyUpload(bytes: Uint8Array, filename: string): UploadKind {
  if (bytes.byteLength === 0) throw new UploadError("upload_empty", UPLOAD_ERROR_MESSAGES.upload_empty);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new UploadError("upload_too_large", UPLOAD_ERROR_MESSAGES.upload_too_large);
  const sniffed = sniffKind(bytes);
  if (!sniffed) throw new UploadError("upload_unsupported", UPLOAD_ERROR_MESSAGES.upload_unsupported);

  // An OLE container is a legacy .doc, a password-protected .docx, or an Excel or PowerPoint file.
  // Look inside before comparing with the name, so a protected .docx gets the right message.
  if (sniffed === "doc") {
    // Stream names sit in the directory as UTF-16, at either byte alignment.
    const text = Buffer.from(bytes).toString("utf16le") + Buffer.from(bytes.subarray(1)).toString("utf16le");
    if (/EncryptedPackage|EncryptionInfo/.test(text)) throw new UploadError("upload_encrypted_word", UPLOAD_ERROR_MESSAGES.upload_encrypted_word);
    if (!/WordDocument/.test(text)) throw new UploadError("upload_unsupported", UPLOAD_ERROR_MESSAGES.upload_unsupported);
    if (/_VBA_PROJECT|Macros/.test(text)) throw new UploadError("upload_macros", UPLOAD_ERROR_MESSAGES.upload_macros);
  }

  const named = kindFromName(filename);
  if (named && named !== sniffed) throw new UploadError("upload_name_mismatch", UPLOAD_ERROR_MESSAGES.upload_name_mismatch);

  if (sniffed === "docx") {
    const entries = listZipEntries(bytes);
    if (!entries) throw new UploadError("upload_unsupported", UPLOAD_ERROR_MESSAGES.upload_unsupported);
    if (entries.length > MAX_DOCX_ENTRIES) throw new UploadError("upload_zip_bomb", UPLOAD_ERROR_MESSAGES.upload_zip_bomb);
    const total = entries.reduce((s, e) => s + e.uncompressed, 0);
    if (total > MAX_DOCX_UNCOMPRESSED_BYTES) throw new UploadError("upload_zip_bomb", UPLOAD_ERROR_MESSAGES.upload_zip_bomb);
    const names = entries.map((e) => e.name.toLowerCase());
    // a real .docx has [Content_Types].xml and word/document.xml; an encrypted one is an OLE file, not a zip
    if (!names.includes("[content_types].xml") || !names.some((n) => n === "word/document.xml")) {
      throw new UploadError("upload_unsupported", UPLOAD_ERROR_MESSAGES.upload_unsupported);
    }
    if (names.some((n) => n.endsWith("vbaproject.bin") || n.startsWith("word/vbadata"))) {
      throw new UploadError("upload_macros", UPLOAD_ERROR_MESSAGES.upload_macros);
    }
    return "docx";
  }

  return sniffed;
}
