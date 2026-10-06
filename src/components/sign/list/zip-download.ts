"use client";

// Doc Sign, the documents list: download the signed files of the ticked documents as one zip. The route answers a
// failure as JSON, so the answer is read before it is saved; a SignApiError carries the code the screen words.

import { fileNameFrom } from "@/components/sign/detail/download";
import { SignApiError } from "@/lib/sign/client/api";

export interface ZipDownloaded {
  included: number;
  skipped: number;
}

export async function downloadZip(ids: readonly string[]): Promise<ZipDownloaded> {
  let res: Response;
  try {
    res = await fetch("/api/sign/documents/zip", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  } catch {
    throw new SignApiError("network", "Could not reach the server.", 0);
  }
  if (!res.ok) {
    let code = res.status === 401 ? "signed_out" : res.status === 403 ? "forbidden" : res.status === 429 ? "rate_limited" : "request_failed";
    try {
      const body = (await res.json()) as { code?: unknown };
      if (typeof body.code === "string") code = body.code;
    } catch {
      // not JSON
    }
    throw new SignApiError(code, `Request failed (${res.status})`, res.status);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = fileNameFrom(res.headers.get("Content-Disposition"), "signed-documents.zip");
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
  return { included: Number(res.headers.get("X-Sign-Zip-Included")) || 0, skipped: Number(res.headers.get("X-Sign-Zip-Skipped")) || 0 };
}
