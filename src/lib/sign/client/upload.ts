// ============================================================
// Doc Sign, browser side: starting a draft from a file. The file is checked here first (so a wrong file is
// named at once, not after a long upload) and sent with progress, which `fetch` cannot report.
// The server checks everything again from the bytes; this is only to be kind and quick.
// ============================================================

import { SignApiError, type SignIssue } from "./api";

export const MAX_UPLOAD_MB = 25;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/** What the file chooser offers. */
export const UPLOAD_ACCEPT = ".pdf,.docx,.doc,.png,.jpg,.jpeg,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,image/png,image/jpeg";

const EXTENSIONS = new Set(["pdf", "docx", "doc", "png", "jpg", "jpeg"]);
const WORD_EXTENSIONS = new Set(["docx", "doc"]);

const extensionOf = (name: string): string => /\.([A-Za-z0-9]+)$/.exec(name.trim())?.[1]?.toLowerCase() ?? "";

/** The failure code (worded by `errors.<code>`) for a file that cannot be used, or null when it can. */
export function checkUploadFile(file: { name: string; size: number }): "upload_empty" | "upload_too_large" | "upload_unsupported" | null {
  if (!EXTENSIONS.has(extensionOf(file.name))) return "upload_unsupported";
  if (file.size <= 0) return "upload_empty";
  if (file.size > MAX_UPLOAD_BYTES) return "upload_too_large";
  return null;
}

export const isWordFile = (name: string): boolean => WORD_EXTENSIONS.has(extensionOf(name));

/** A file name without its extension, for a suggested title. */
export const titleFromFileName = (name: string): string => name.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();

/** "1.4 MB", "820 KB": one decimal for megabytes. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface CreatedDraft {
  document: { id: string; reference: string | null; title: string; status: string; pageCount: number | null };
  converted?: boolean;
}

/** Upload a file and create the draft. `onProgress` gets 0..1 while the file is being sent. */
export function uploadDraft(args: { file: File; title?: string; categoryId?: string | null; contactId?: string | null; ticketId?: string | null; dealId?: string | null; isPrivate?: boolean; onProgress?: (fraction: number) => void; signal?: AbortSignal }): Promise<CreatedDraft> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", args.file, args.file.name);
    if (args.title?.trim()) form.append("title", args.title.trim());
    if (args.categoryId) form.append("categoryId", args.categoryId);
    if (args.contactId) form.append("contactId", args.contactId);
    if (args.ticketId) form.append("ticketId", args.ticketId);
    if (args.dealId) form.append("dealId", args.dealId);
    // migration 176: private to whoever uploads it, the workspace's admins and the Halo users named on it
    if (args.isPrivate) form.append("isPrivate", "true");

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/sign/documents");
    xhr.withCredentials = true;
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) args.onProgress?.(Math.min(1, e.loaded / e.total));
    };
    xhr.onerror = () => reject(new SignApiError("network", "Could not reach the server.", 0));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    xhr.onload = () => {
      let body: { error?: unknown; code?: unknown; issues?: unknown } & Partial<CreatedDraft> = {};
      try {
        body = JSON.parse(xhr.responseText || "{}");
      } catch {
        // not JSON: a proxy's page
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.document) {
        resolve(body as CreatedDraft);
        return;
      }
      const code = typeof body.code === "string" ? body.code : xhr.status === 413 ? "upload_too_large" : xhr.status === 401 ? "signed_out" : xhr.status === 403 ? "forbidden" : xhr.status === 429 ? "rate_limited" : "request_failed";
      reject(new SignApiError(code, typeof body.error === "string" ? body.error : `Request failed (${xhr.status})`, xhr.status, Array.isArray(body.issues) ? (body.issues as SignIssue[]) : []));
    };
    args.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}
