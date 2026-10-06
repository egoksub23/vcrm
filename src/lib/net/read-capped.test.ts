import { describe, expect, it } from "vitest";

import { readBodyCapped } from "./read-capped";

const streamOf = (chunks: Uint8Array[], onPull?: () => void) => {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
};

describe("readBodyCapped", () => {
  it("returns the whole body when it is within the cap, in the order it came", async () => {
    const request = new Request("https://halo.test/x", { method: "POST", body: "hello world" });
    const raw = await readBodyCapped(request, 100);
    expect(new TextDecoder().decode(raw!)).toBe("hello world");
  });

  it("returns an empty body for a request that has none", async () => {
    expect((await readBodyCapped(new Request("https://halo.test/x"), 10))!.byteLength).toBe(0);
  });

  it("gives up as soon as the cap is passed, without reading the rest of a body sent in pieces (no length declared)", async () => {
    let pulls = 0;
    const piece = new Uint8Array(1000).fill(65);
    // an endless stream: reading it all would never end
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(piece);
      },
    });
    const raw = await readBodyCapped({ body: endless }, 5000);
    expect(raw).toBeNull();
    // it stopped a little after the cap, not after the whole stream
    expect(pulls).toBeLessThan(20);
  });

  it("holds the cap exactly: a body of the cap's size is read, one byte more is refused", async () => {
    expect((await readBodyCapped({ body: streamOf([new Uint8Array(10)]) }, 10))!.byteLength).toBe(10);
    expect(await readBodyCapped({ body: streamOf([new Uint8Array(10), new Uint8Array(1)]) }, 10)).toBeNull();
  });
});
