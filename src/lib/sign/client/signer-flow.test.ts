import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlacedField } from "../pdf/types";
import type { OtherSigner } from "../service/signing";
import {
  AutosaveQueue,
  adoptedFromInput,
  canTypeSignature,
  answerFromAdopted,
  answersFromStored,
  checkboxAnswer,
  completionPayload,
  computeProgress,
  describeOthers,
  evaluateAnswer,
  fieldProblem,
  fieldStatus,
  initialsOf,
  isEndScreen,
  localeFromAcceptLanguage,
  nextAttentionKey,
  othersStillToSign,
  pollDelayMs,
  readingOrder,
  resolveSignerLocale,
  screenFor,
  shouldPoll,
  signerFields,
  touchRects,
  systemFieldText,
  typedAnswer,
  type SaveResponse,
  type SaveState,
} from "./signer-flow";
import { SignApiError } from "./api";

// a one-pixel PNG, valid for the image check
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function field(over: Partial<PlacedField> & Pick<PlacedField, "key">): PlacedField {
  return { type: "text", role: "merchant", page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.05, required: true, ...over };
}

describe("resolveSignerLocale", () => {
  it("prefers the address, then the document, then the fallback, then English", () => {
    expect(resolveSignerLocale({ query: "ko", document: "ms" })).toBe("ko");
    expect(resolveSignerLocale({ query: undefined, document: "ms" })).toBe("ms");
    expect(resolveSignerLocale({ query: "xx", document: "zh" })).toBe("zh");
    expect(resolveSignerLocale({ query: null, document: null, fallback: "ko" })).toBe("ko");
    expect(resolveSignerLocale({})).toBe("en");
  });
  it("reads regional codes and the first of several values", () => {
    expect(resolveSignerLocale({ query: ["ms-MY", "en"] })).toBe("ms");
    expect(resolveSignerLocale({ query: "ZH_cn" })).toBe("zh");
  });
  it("ignores languages the page does not have", () => {
    expect(resolveSignerLocale({ query: "es", document: "pt" })).toBe("en");
  });
});

describe("localeFromAcceptLanguage", () => {
  it("takes the most wanted language the page has", () => {
    expect(localeFromAcceptLanguage("ms-MY,ms;q=0.9,en;q=0.8")).toBe("ms");
    expect(localeFromAcceptLanguage("fr;q=0.9, ko;q=0.8, en;q=0.5")).toBe("ko");
    expect(localeFromAcceptLanguage("en;q=0.4, zh-CN;q=0.9")).toBe("zh");
  });
  it("is English when nothing matches or there is no header", () => {
    expect(localeFromAcceptLanguage("fr, de;q=0.5")).toBe("en");
    expect(localeFromAcceptLanguage("")).toBe("en");
    expect(localeFromAcceptLanguage(null)).toBe("en");
    expect(localeFromAcceptLanguage("ko;q=0")).toBe("en");
  });
});

describe("screenFor", () => {
  const v = (state: Parameters<typeof screenFor>[0]["state"], needsCode = false, needsConsent = false) => ({ state, needsCode, needsConsent });
  it("asks for the code first, then consent, then the document", () => {
    expect(screenFor(v("active", true, true))).toBe("code");
    expect(screenFor(v("active", false, true))).toBe("consent");
    expect(screenFor(v("active"))).toBe("fill");
  });
  it("asks for the code again on a signed page, whose content needs it", () => {
    expect(screenFor(v("signed", true))).toBe("code");
    expect(screenFor(v("signed"))).toBe("signed");
  });
  it("shows every other state as itself", () => {
    for (const s of ["sealing", "completed", "declined", "expired", "voided", "failed", "not_invited"] as const) expect(screenFor(v(s))).toBe(s);
  });
  it("knows which screens are final and which one polls", () => {
    expect(isEndScreen("fill")).toBe(false);
    expect(isEndScreen("code")).toBe(false);
    expect(isEndScreen("expired")).toBe(true);
    expect(shouldPoll("sealing")).toBe(true);
    expect(shouldPoll("signed")).toBe(false);
  });
});

describe("pollDelayMs", () => {
  it("is five seconds for two minutes, then backs off", () => {
    expect(pollDelayMs(0)).toBe(5000);
    expect(pollDelayMs(119_999)).toBe(5000);
    expect(pollDelayMs(120_000)).toBe(15_000);
    expect(pollDelayMs(6 * 60_000)).toBe(30_000);
    expect(pollDelayMs(60 * 60_000)).toBe(60_000);
  });
});

describe("describeOthers", () => {
  const o = (name: string, orderNo: number, status: OtherSigner["status"], kind: OtherSigner["kind"] = "signer"): OtherSigner => ({
    name,
    roleKey: name,
    kind,
    status,
    orderNo,
    signedAt: status === "signed" ? "2026-10-06T10:00:00Z" : null,
  });
  it("names the one whose turn it is when there is an order", () => {
    const rows = describeOthers([o("C", 3, "pending"), o("A", 1, "signed"), o("B", 2, "sent")], true);
    expect(rows.map((r) => [r.name, r.kind])).toEqual([
      ["A", "signed"],
      ["B", "turn"],
      ["C", "waiting"],
    ]);
  });
  it("does not name a turn without an order", () => {
    const rows = describeOthers([o("A", 1, "viewed"), o("B", 1, "sent")], false);
    expect(rows.every((r) => r.kind === "invited")).toBe(true);
  });
  it("marks a decline and a filler", () => {
    const rows = describeOthers([o("A", 1, "declined"), o("B", 2, "signed", "filler")], true);
    expect(rows[0].kind).toBe("declined");
    expect(rows[1].filler).toBe(true);
  });
  it("counts who is left", () => {
    expect(othersStillToSign([o("A", 1, "signed"), o("B", 2, "sent"), o("C", 3, "pending"), o("D", 4, "declined")])).toBe(2);
  });
});

describe("evaluateAnswer", () => {
  it("accepts a good picture and refuses a bad one without needing Node's Buffer", () => {
    const sig = field({ key: "sig", type: "signature" });
    expect(evaluateAnswer(sig, { image: PNG })).toEqual({ status: "ok" });
    expect(evaluateAnswer(sig, { image: "data:image/png;base64,AAAA" })).toEqual({ status: "invalid", code: "bad_image" });
    expect(evaluateAnswer(sig, { image: "nonsense" })).toEqual({ status: "invalid", code: "bad_image" });
  });
  it("uses the server's rules for the rest", () => {
    expect(evaluateAnswer(field({ key: "n", type: "number" }), { text: "1,200.5" })).toEqual({ status: "ok" });
    expect(evaluateAnswer(field({ key: "n", type: "number" }), { text: "abc" })).toEqual({ status: "invalid", code: "not_a_number" });
    expect(evaluateAnswer(field({ key: "d", type: "date" }), { text: "2026-02-30" })).toEqual({ status: "invalid", code: "not_a_date" });
    expect(evaluateAnswer(field({ key: "t" }), { text: "   " })).toEqual({ status: "empty" });
    expect(evaluateAnswer(field({ key: "s", type: "signature" }), { typed: "Ali" })).toEqual({ status: "ok" });
    expect(evaluateAnswer(field({ key: "dd", type: "dropdown", options: ["a", "b"] }), { text: "c" })).toEqual({ status: "invalid", code: "not_an_option" });
  });
});

describe("fields, progress and the Next order", () => {
  const fields: PlacedField[] = [
    field({ key: "late", page: 1, y: 0.2 }),
    field({ key: "sig", type: "signature", page: 0, y: 0.8, x: 0.5 }),
    field({ key: "name", type: "name", page: 0, y: 0.1 }),
    field({ key: "opt", page: 0, y: 0.3, required: false }),
    field({ key: "ini", type: "initials", page: 0, y: 0.8, x: 0.1 }),
    field({ key: "other", role: "director", page: 0, y: 0.05 }),
    field({ key: "date", type: "date_signed", page: 0, y: 0.9 }),
  ];
  const { mine, system } = signerFields(fields, "merchant");

  it("lists this person's fields in reading order and sets the system ones aside", () => {
    expect(mine.map((f) => f.key)).toEqual(["opt", "ini", "sig", "late"]);
    expect(system.map((f) => f.key)).toEqual(["name", "date"]);
  });
  it("treats fields a row apart by under one percent as one row, left to right", () => {
    const rows = readingOrder([
      { key: "b", page: 0, x: 0.6, y: 0.501 },
      { key: "a", page: 0, x: 0.1, y: 0.505 },
      { key: "c", page: 0, x: 0.1, y: 0.7 },
    ]);
    expect(rows.map((f) => f.key)).toEqual(["a", "b", "c"]);
  });
  it("counts progress on required fields only", () => {
    const p = computeProgress(mine, { sig: { typed: "Ali" } });
    expect(p).toMatchObject({ required: 3, done: 1, attention: ["ini", "late"], canFinish: false });
    const all = computeProgress(mine, { sig: { typed: "Ali" }, ini: { typed: "A" }, late: { text: "x" } });
    expect(all).toMatchObject({ required: 3, done: 3, attention: [], canFinish: true });
  });
  it("blocks finishing on a value that is not acceptable, even an optional one", () => {
    const p = computeProgress(mine, { sig: { typed: "Ali" }, ini: { typed: "A" }, late: { text: "x" }, opt: { text: "y".repeat(500) } });
    expect(p.attention).toEqual(["opt"]);
    expect(p.canFinish).toBe(false);
    expect(fieldProblem(mine[0], { opt: { text: "y".repeat(500) } })).toBe("text_too_long");
  });
  it("marks a field the server turned down until it changes", () => {
    const sig = mine.find((f) => f.key === "sig")!;
    expect(fieldStatus(sig, { sig: { typed: "Ali" } }, { sig: "bad_typed_signature" })).toBe("invalid");
    expect(fieldStatus(sig, { sig: { typed: "Ali" } })).toBe("done");
    expect(fieldStatus(sig, {})).toBe("todo");
    expect(fieldStatus(mine[0], {})).toBe("optional");
  });
  it("goes to the next field that needs attention, round to the start at the end", () => {
    const attention = ["ini", "late"];
    expect(nextAttentionKey(mine, attention)).toBe("ini");
    expect(nextAttentionKey(mine, attention, "ini")).toBe("late");
    expect(nextAttentionKey(mine, attention, "late")).toBe("ini");
    expect(nextAttentionKey(mine, attention, "opt")).toBe("ini");
    expect(nextAttentionKey(mine, ["ini"], "ini")).toBe("ini");
    expect(nextAttentionKey(mine, [], "ini")).toBeNull();
  });
});

describe("touchRects", () => {
  const page = { width: 360, height: 500 };
  const at = (key: string, x: number, y: number, w: number, h: number) => ({ key, x, y, w, h });

  it("grows a small box to 44 px each way around its middle", () => {
    const r = touchRects([at("a", 0.4, 0.4, 0.1, 0.02)], page)["a"];
    expect(r.w * page.width).toBeCloseTo(44, 5);
    expect(r.h * page.height).toBeCloseTo(44, 5);
    expect(r.x + r.w / 2).toBeCloseTo(0.45, 5);
    expect(r.y + r.h / 2).toBeCloseTo(0.41, 5);
  });
  it("leaves a box that is big enough as it is", () => {
    expect(touchRects([at("a", 0.1, 0.1, 0.5, 0.2)], page)["a"]).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.2 });
  });
  it("shares the gap with a neighbour instead of overlapping it", () => {
    // two 12 px fields, 18 px apart (30 px from top to top) and one above the other
    const rects = touchRects([at("a", 0.1, 0.4, 0.3, 12 / 500), at("b", 0.1, 0.4 + 30 / 500, 0.3, 12 / 500)], page);
    const aBottom = (rects.a.y + rects.a.h) * page.height;
    const bTop = rects.b.y * page.height;
    expect(aBottom).toBeLessThanOrEqual(bTop + 1e-6);
    // each took half of the 18 px gap below or above, so the two boxes meet in the middle
    expect(bTop - aBottom).toBeCloseTo(0, 5);
    expect(rects.a.h * page.height).toBeCloseTo(12 + 9 + 16, 5);
  });
  it("does not let side by side fields run into each other", () => {
    const rects = touchRects([at("a", 0.1, 0.4, 20 / 360, 0.1), at("b", 0.1 + 26 / 360, 0.4, 20 / 360, 0.1)], page);
    expect((rects.a.x + rects.a.w) * page.width).toBeLessThanOrEqual(rects.b.x * page.width + 1e-6);
  });
  it("does not grow a box that already touches another", () => {
    const rects = touchRects([at("a", 0.1, 0.4, 0.1, 0.02), at("b", 0.15, 0.405, 0.1, 0.02)], page);
    expect(rects.a).toEqual({ x: 0.1, y: 0.4, w: 0.1, h: 0.02 });
  });
  it("ignores fields far away", () => {
    const rects = touchRects([at("a", 0.1, 0.1, 0.1, 0.02), at("b", 0.1, 0.9, 0.1, 0.02)], page);
    expect(rects.a.h * page.height).toBeCloseTo(44, 5);
    expect(rects.b.h * page.height).toBeCloseTo(44, 5);
  });
});

describe("building answers", () => {
  it("a ticked box is true and an unticked one is no answer", () => {
    expect(checkboxAnswer(true)).toEqual({ checked: true });
    expect(checkboxAnswer(false)).toEqual({});
  });
  it("makes initials from a name", () => {
    expect(initialsOf("Ali bin Ahmad")).toBe("ABA");
    expect(initialsOf("  ali  ")).toBe("A");
    expect(initialsOf("王小明")).toBe("王小");
    expect(initialsOf("김민수")).toBe("김민");
    expect(initialsOf("")).toBe("");
  });
  it("cuts a typed signature to the length the server allows", () => {
    expect(typedAnswer({ type: "initials" }, "ABCDEFGHIJKLM")).toEqual({ typed: "ABCDEFGHIJ" });
    expect(typedAnswer({ type: "signature" }, "  Ali  ")).toEqual({ typed: "Ali" });
    expect(typedAnswer({ type: "signature" }, "   ")).toEqual({});
  });
  it("lets only Latin writing be typed as a signature", () => {
    expect(canTypeSignature("Ali bin Ahmad")).toBe(true);
    expect(canTypeSignature("Nguyễn Văn An")).toBe(true);
    expect(canTypeSignature("D'Souza-O’Neil Jr.")).toBe(true);
    expect(canTypeSignature("王小明")).toBe(false);
    expect(canTypeSignature("김민수")).toBe(false);
    expect(canTypeSignature("Ali 王")).toBe(false);
    expect(canTypeSignature("")).toBe(false);
  });
  it("reuses an adopted signature for initials", () => {
    expect(answerFromAdopted({ type: "initials" }, { mode: "type", typed: "Ali bin Ahmad" })).toEqual({ typed: "ABA" });
    expect(answerFromAdopted({ type: "signature" }, { mode: "type", typed: "Ali bin Ahmad" })).toEqual({ typed: "Ali bin Ahmad" });
    expect(answerFromAdopted({ type: "initials" }, { mode: "draw", image: PNG })).toEqual({ image: PNG });
  });
  it("makes an adopted signature only from something to reuse", () => {
    expect(adoptedFromInput({ typed: "Ali" }, "type")).toEqual({ mode: "type", typed: "Ali" });
    expect(adoptedFromInput({ image: PNG }, "draw")).toEqual({ mode: "draw", image: PNG });
    expect(adoptedFromInput({ image: PNG }, "type")).toBeNull();
    expect(adoptedFromInput({}, "upload")).toBeNull();
  });
  it("turns stored answers back into inputs", () => {
    expect(answersFromStored({ a: { text: "x" }, b: { checked: true }, c: { image: PNG, mime: "image/png" }, d: { typed: "Ali" } })).toEqual({
      a: { text: "x" },
      b: { checked: true },
      c: { image: PNG },
      d: { typed: "Ali" },
    });
  });
  it("writes the system fields", () => {
    const now = new Date("2026-10-06T10:00:00Z");
    expect(systemFieldText(field({ key: "n", type: "name" }), "Ali bin Ahmad", now, "en")).toBe("Ali bin Ahmad");
    expect(systemFieldText(field({ key: "d", type: "date_signed" }), "Ali", now, "en")).toBe("06 Oct 2026");
    expect(systemFieldText(field({ key: "d", type: "date_signed", dateFormat: "DD/MM/YYYY" }), "Ali", now, "ms")).toBe("06/10/2026");
  });
  it("leaves out pictures the server already has, and anything not acceptable", () => {
    const mine = [field({ key: "sig", type: "signature" }), field({ key: "ini", type: "initials" }), field({ key: "t" }), field({ key: "bad", type: "number" })];
    const answers = { sig: { image: PNG }, ini: { image: PNG }, t: { text: "hello" }, bad: { text: "abc" } };
    const saved = answers.sig;
    expect(completionPayload(mine, answers, (key, input) => key === "sig" && input === saved)).toEqual({ ini: { image: PNG }, t: { text: "hello" } });
  });
});

describe("AutosaveQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const ok = (saved: string[] = [], rejected: SaveResponse["rejected"] = []): SaveResponse => ({ saved, rejected });
  const network = () => new SignApiError("network", "offline", 0);
  const retryable = (e: unknown) => e instanceof SignApiError && (e.code === "network" || e.status >= 500);

  function make(send: (b: Record<string, { text?: unknown }>) => Promise<SaveResponse>, extra: Partial<ConstructorParameters<typeof AutosaveQueue>[0]> = {}) {
    const states: SaveState[] = [];
    const queue = new AutosaveQueue({ send, isRetryable: retryable, isOffline: (e) => e instanceof SignApiError && e.code === "network", onState: (s) => states.push(s), ...extra });
    return { queue, states };
  }

  it("waits a second after the last change and sends one batch with the newest values", async () => {
    const send = vi.fn(async (b: Record<string, { text?: unknown }>) => ok(Object.keys(b)));
    const { queue, states } = make(send);
    queue.set("a", { text: "1" });
    await vi.advanceTimersByTimeAsync(600);
    queue.set("b", { text: "2" });
    queue.set("a", { text: "3" });
    await vi.advanceTimersByTimeAsync(900);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ a: { text: "3" }, b: { text: "2" } });
    expect(queue.pendingCount).toBe(0);
    expect(states).toEqual(["saving", "saved"]);
  });

  it("sends at once on flush and says whether everything is saved", async () => {
    const send = vi.fn(async (b: Record<string, { text?: unknown }>) => ok(Object.keys(b)));
    const { queue } = make(send);
    queue.set("a", { text: "1" });
    await expect(queue.flush()).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps the values while offline, shows offline, and sends them when the connection is back", async () => {
    let up = false;
    const send = vi.fn(async (b: Record<string, { text?: unknown }>) => {
      if (!up) throw network();
      return ok(Object.keys(b));
    });
    const { queue, states } = make(send);
    queue.set("a", { text: "1" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.state).toBe("offline");
    expect(queue.pendingCount).toBe(1);
    // the first retry comes after two seconds, and fails again
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledTimes(2);
    // back online: the next retry (five seconds later) succeeds
    up = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith({ a: { text: "1" } });
    expect(queue.state).toBe("saved");
    expect(states).toContain("offline");
  });

  it("retries at once when told the connection is back", async () => {
    let up = false;
    const send = vi.fn(async (b: Record<string, { text?: unknown }>) => {
      if (!up) throw network();
      return ok(Object.keys(b));
    });
    const { queue } = make(send);
    queue.set("a", { text: "1" });
    await vi.advanceTimersByTimeAsync(1000);
    up = true;
    queue.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(queue.state).toBe("saved");
  });

  it("does not lose a value entered while a send is in flight, and does not overwrite it when the send fails", async () => {
    let release!: () => void;
    let calls = 0;
    const send = vi.fn(async (b: Record<string, { text?: unknown }>) => {
      calls++;
      if (calls === 1) {
        await new Promise<void>((r) => (release = r));
        throw network();
      }
      return ok(Object.keys(b));
    });
    const { queue } = make(send);
    queue.set("a", { text: "old" });
    await vi.advanceTimersByTimeAsync(1000);
    queue.set("a", { text: "new" });
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenLastCalledWith({ a: { text: "new" } });
    expect(queue.pendingCount).toBe(0);
  });

  it("reports values the server turned down and does not send them again", async () => {
    const send = vi.fn(async () => ok([], [{ field: "a", code: "not_a_number" }]));
    const onRejected = vi.fn();
    const { queue } = make(send, { onRejected });
    queue.set("a", { text: "x" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onRejected).toHaveBeenCalledWith([{ field: "a", code: "not_a_number" }]);
    expect(queue.pendingCount).toBe(0);
    expect(queue.isSaved("a", { text: "x" })).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("remembers the exact value the server has", async () => {
    const send = vi.fn(async (b: Record<string, { text?: unknown }>) => ok(Object.keys(b)));
    const { queue } = make(send);
    const value = { image: PNG };
    queue.set("sig", value);
    await queue.flush();
    expect(queue.isSaved("sig", value)).toBe(true);
    expect(queue.isSaved("sig", { image: PNG })).toBe(false);
    queue.set("sig", { image: PNG });
    expect(queue.isSaved("sig", value)).toBe(false);
  });

  it("stops and reports a failure that trying again will not fix, keeping the values", async () => {
    const send = vi.fn(async () => {
      throw new SignApiError("code_required", "Enter the code first.", 403);
    });
    const onFailure = vi.fn();
    const { queue } = make(send, { onFailure });
    queue.set("a", { text: "1" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(queue.state).toBe("error");
    expect(queue.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).toHaveBeenCalledTimes(1);
    // after the code is entered again
    queue.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("splits a large queue into several requests", async () => {
    const send = vi.fn(async (b: Record<string, { text?: unknown }>) => ok(Object.keys(b)));
    const { queue } = make(send, { maxBatchChars: 40 });
    for (const k of ["a", "b", "c", "d"]) queue.set(k, { text: "x".repeat(20) });
    await queue.flush();
    expect(send.mock.calls.length).toBeGreaterThan(1);
    expect(send.mock.calls.flatMap((c) => Object.keys(c[0])).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("works again after being revived, and sends what was waiting", async () => {
    const send = vi.fn(async (b: Record<string, { text?: unknown }>) => ok(Object.keys(b)));
    const { queue } = make(send);
    queue.set("a", { text: "1" });
    queue.dispose();
    queue.revive();
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    queue.set("b", { text: "2" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does nothing after it is disposed", async () => {
    const send = vi.fn(async (b: Record<string, { text?: unknown }>) => ok(Object.keys(b)));
    const { queue } = make(send);
    queue.set("a", { text: "1" });
    queue.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).not.toHaveBeenCalled();
  });
});
