// ============================================================
// The Word-to-PDF converter client (docs/vircle-sign-plan.md, section 6).
//
// The converter is Gotenberg (LibreOffice inside), a separate container Halo reaches at one fixed
// address, SIGN_CONVERTER_URL, over a network with no way out to the internet. Halo's general outbound
// guard (pinnedFetch) refuses private addresses on purpose, so this is a separate, trusted client
// that only ever calls the configured address: no workspace, user or uploaded file can choose it.
// ============================================================

import { isPdf, openPdf, PdfError } from "../pdf/load";

export type ConvertErrorCode = "converter_not_configured" | "converter_unavailable" | "conversion_timeout" | "conversion_failed" | "conversion_too_long";

export class ConvertError extends Error {
  readonly code: ConvertErrorCode;
  constructor(code: ConvertErrorCode, message: string) {
    super(message);
    this.name = "ConvertError";
    this.code = code;
  }
}

export const CONVERT_ERROR_MESSAGES: Record<ConvertErrorCode, string> = {
  converter_not_configured: "Word conversion is not available right now. Upload a PDF instead.",
  converter_unavailable: "Word conversion is not available right now. Upload a PDF instead.",
  conversion_timeout: "This Word file took too long to convert. Save it as a PDF and upload that instead.",
  conversion_failed: "This Word file could not be converted. Check that it opens in Word, or save it as a PDF and upload that instead.",
  conversion_too_long: "This Word file converts to more than 50 pages, which is the most that can be converted. Upload it as a PDF instead.",
};

/** A converted document may not run past this many pages (a PDF upload may have up to 200). */
export const MAX_CONVERTED_PAGES = 50;
export const CONVERT_TIMEOUT_MS = 60_000;

/** The configured converter address, validated, or null when none is set. */
export function converterUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.SIGN_CONVERTER_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return null;
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export interface ConvertOptions {
  /** Defaults to SIGN_CONVERTER_URL. */
  baseUrl?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Convert a Word file to PDF. The result is checked to be a real PDF within the page limit. */
export async function convertWordToPdf(
  bytes: Uint8Array,
  filename: string,
  options: ConvertOptions = {},
): Promise<{ pdf: Uint8Array; pageCount: number }> {
  const base = options.baseUrl === undefined ? converterUrl() : options.baseUrl;
  if (!base) throw new ConvertError("converter_not_configured", CONVERT_ERROR_MESSAGES.converter_not_configured);
  const doFetch = options.fetchImpl ?? fetch;

  const safeName = /\.(docx|doc)$/i.test(filename) ? "document." + filename.split(".").pop()!.toLowerCase() : "document.docx";
  const form = new FormData();
  // single file field; Gotenberg picks the converter from the extension
  form.append("files", new Blob([bytes as BlobPart]), safeName);
  // PDF/A is not wanted (signatures need a normal PDF); keep the document's own page setup
  form.append("landscape", "false");
  form.append("nativePageRanges", `1-${MAX_CONVERTED_PAGES + 1}`);

  let res: Response;
  try {
    res = await doFetch(`${base}/forms/libreoffice/convert`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs ?? CONVERT_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ConvertError("conversion_timeout", CONVERT_ERROR_MESSAGES.conversion_timeout);
    }
    throw new ConvertError("converter_unavailable", CONVERT_ERROR_MESSAGES.converter_unavailable);
  }

  if (res.status === 503 || res.status === 502 || res.status === 504) {
    // the converter is up but busy or restarting
    throw new ConvertError("converter_unavailable", CONVERT_ERROR_MESSAGES.converter_unavailable);
  }
  if (!res.ok) throw new ConvertError("conversion_failed", CONVERT_ERROR_MESSAGES.conversion_failed);

  let pdf: Uint8Array;
  try {
    pdf = new Uint8Array(await res.arrayBuffer());
  } catch {
    throw new ConvertError("conversion_timeout", CONVERT_ERROR_MESSAGES.conversion_timeout);
  }
  if (!isPdf(pdf)) throw new ConvertError("conversion_failed", CONVERT_ERROR_MESSAGES.conversion_failed);

  let pageCount: number;
  try {
    pageCount = (await openPdf(pdf)).getPageCount();
  } catch (err) {
    if (err instanceof PdfError && err.code === "pdf_too_many_pages") {
      throw new ConvertError("conversion_too_long", CONVERT_ERROR_MESSAGES.conversion_too_long);
    }
    throw new ConvertError("conversion_failed", CONVERT_ERROR_MESSAGES.conversion_failed);
  }
  if (pageCount > MAX_CONVERTED_PAGES) throw new ConvertError("conversion_too_long", CONVERT_ERROR_MESSAGES.conversion_too_long);
  return { pdf, pageCount };
}

export interface ConverterHealth {
  configured: boolean;
  ok: boolean;
  /** Milliseconds the health call took, when it answered. */
  ms?: number;
  detail?: string;
}

/** Ask the converter whether it is up (Gotenberg's /health). Never throws. */
export async function converterHealth(options: { baseUrl?: string | null; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<ConverterHealth> {
  const base = options.baseUrl === undefined ? converterUrl() : options.baseUrl;
  if (!base) return { configured: false, ok: false, detail: "SIGN_CONVERTER_URL is not set" };
  const started = Date.now();
  try {
    const res = await (options.fetchImpl ?? fetch)(`${base}/health`, { signal: AbortSignal.timeout(options.timeoutMs ?? 5000), redirect: "error" });
    return { configured: true, ok: res.ok, ms: Date.now() - started, detail: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { configured: true, ok: false, detail: err instanceof Error ? err.name : "error" };
  }
}
