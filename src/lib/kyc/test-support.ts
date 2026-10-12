// Shared by the KYC tests only: a back end that is a function, bytes that look like images, and the environment of a configured workspace.
// Nothing here touches the network.

import type { KycFetch, KycTransport } from "./client";

export const BASE_URL = "https://apis-uat.vircle.com/verify_doc";
/** A made-up key. Tests search every answer and every audit row for it. */
export const API_KEY = "test-api-key-DO-NOT-LEAK-7f3a9c";

export const ENV = { KYC_DOC_API_BASE_URL: BASE_URL, KYC_DOC_API_KEY: API_KEY } as Record<string, string | undefined>;

export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
export const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
export const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
export const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const text = (body: string, status = 200, headers: Record<string, string> = {}): Response => new Response(body, { status, headers });

export const bytes = (b: Uint8Array, contentType: string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(b as unknown as BodyInit, { status, headers: { "content-type": contentType, ...headers } });

/** A record as the (guessed) back end might send it. */
export const RECORD = {
  id: "val_123",
  friend_id: "child-77",
  type: "nric",
  status: "verified",
  created_at: "2026-10-01T08:30:00Z",
  confidence: 0.93,
  full_name: "Aisyah binti Ali",
  nric: "150304101234",
  date_of_birth: "2015-03-04",
  address: "12 Jalan Mawar, 50000 Kuala Lumpur",
};
export const RECORD_2 = { ...RECORD, id: "val_124", created_at: "2026-10-03T08:30:00Z", status: "pending", nric: "160405105678", date_of_birth: "2016-04-05", address: "9 Lorong Kenanga" };

export interface Call {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}

/** A transport whose two fetches are functions the test supplies; every call is recorded. */
export function makeTransport(handlers: { api?: (call: Call) => Response | Promise<Response>; image?: (call: Call) => Response | Promise<Response> }) {
  const calls = { api: [] as Call[], image: [] as Call[] };
  const wrap = (kind: "api" | "image"): KycFetch => async (url, init) => {
    const headers: Record<string, string> = {};
    const raw = init.headers;
    if (raw instanceof Headers) raw.forEach((v, k) => (headers[k.toLowerCase()] = v));
    else if (Array.isArray(raw)) for (const [k, v] of raw) headers[k.toLowerCase()] = v;
    else if (raw) for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    const call = { url, init, headers };
    calls[kind].push(call);
    const h = handlers[kind];
    if (!h) throw new Error(`unexpected ${kind} fetch to ${url}`);
    return h(call);
  };
  const transport: KycTransport = { api: wrap("api"), image: wrap("image") };
  return { transport, calls };
}

/** A body that streams n bytes without ever holding them all (a response of unknown length). */
export function streamOf(n: number, chunk = 64 * 1024, first: Uint8Array = JPEG): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= n) {
        controller.close();
        return;
      }
      const size = Math.min(chunk, n - sent);
      const piece = new Uint8Array(size);
      if (sent === 0) piece.set(first.subarray(0, Math.min(first.length, size)));
      controller.enqueue(piece);
      sent += size;
    },
  });
}
