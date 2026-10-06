/**
 * Read a request body without ever holding more than `maxBytes` of it.
 *
 * `request.text()` and `request.formData()` read the whole body, and a `Content-Length` check does not stop a body sent chunked (no length
 * is declared) or one that lies about its length. On a route that anyone can reach, one such request could fill the server's memory.
 * This reads the stream a piece at a time and gives up, cancelling the rest, the moment the total passes the cap.
 *
 * Returns the bytes, or null when the cap was passed (the caller answers 413).
 */
export async function readBodyCapped(request: { body: ReadableStream<Uint8Array<ArrayBufferLike>> | null }, maxBytes: number): Promise<Uint8Array | null> {
  const body = request.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** The most bytes a body of `maxChars` characters can take in UTF-8 (a character is at most 4 bytes). */
export const bytesForChars = (maxChars: number): number => maxChars * 4;
