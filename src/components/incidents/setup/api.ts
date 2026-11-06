// Small fetch helper for the Setup screens: JSON in, JSON out, and the server's plain-words error when there is one.

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

export async function api<T = Record<string, unknown>>(path: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof json.error === "string" ? json.error : "Something went wrong. Try again.", status: res.status };
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, error: "Could not reach the server. Check your connection and try again.", status: 0 };
  }
}
