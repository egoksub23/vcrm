"use client";

// Doc Sign, the detail screen: download one of a document's files. The route answers a failure as JSON, so a
// plain link would leave the reader on a page of code; this fetches the file and saves it, or throws a
// SignApiError the screen words in the reader's language.

import { SignApiError } from "@/lib/sign/client/api";

/** The file name the route suggests, or a fallback. */
export function fileNameFrom(disposition: string | null, fallback: string): string {
  const m = disposition?.match(/filename="?([^";]+)"?/i);
  return m?.[1]?.trim() || fallback;
}

export async function downloadFile(url: string, fallbackName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new SignApiError("network", "Could not reach the server.", 0);
  }
  if (!res.ok) {
    let code = res.status === 401 ? "signed_out" : res.status === 403 ? "forbidden" : "request_failed";
    try {
      const body = (await res.json()) as { code?: unknown };
      if (typeof body.code === "string") code = body.code;
    } catch {
      // not JSON
    }
    throw new SignApiError(code, `Request failed (${res.status})`, res.status);
  }
  const blob = await res.blob();
  const name = fileNameFrom(res.headers.get("Content-Disposition"), fallbackName);
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
