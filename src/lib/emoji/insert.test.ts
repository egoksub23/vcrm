import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { insertAtCursor, insertEmojiInEditor, replaceRangeInField, spliceText } from "./insert";

describe("spliceText", () => {
  it("inserts at the start", () => {
    expect(spliceText("hello", 0, 0, "😀")).toEqual({ value: "😀hello", caret: 2 });
  });
  it("inserts in the middle", () => {
    expect(spliceText("helloworld", 5, 5, "🙂")).toEqual({ value: "hello🙂world", caret: 7 });
  });
  it("inserts at the end", () => {
    expect(spliceText("hello", 5, 5, "👍")).toEqual({ value: "hello👍", caret: 7 });
  });
  it("replaces a selection", () => {
    expect(spliceText("hello world", 6, 11, "🌍")).toEqual({ value: "hello 🌍", caret: 8 });
    expect(spliceText("abc", 0, 3, "x")).toEqual({ value: "x", caret: 1 });
  });
  it("counts a surrogate pair as two caret positions and keeps neighbours intact", () => {
    const r = spliceText("a😀b", 3, 3, "🎉"); // after the existing emoji (2 units), before "b"
    expect(r).toEqual({ value: "a😀🎉b", caret: 5 });
    expect([...r!.value]).toHaveLength(4);
  });
  it("counts a multi-code-point emoji (skin tone, ZWJ) as one insertion", () => {
    const family = "👨‍👩‍👧";
    const r = spliceText("x", 1, 1, family);
    expect(r?.value).toBe(`x${family}`);
    expect(r?.caret).toBe(1 + family.length);
  });
  it("clamps out-of-range positions", () => {
    expect(spliceText("ab", 10, 20, "!")).toEqual({ value: "ab!", caret: 3 });
    expect(spliceText("ab", -5, -1, "!")).toEqual({ value: "!ab", caret: 1 });
  });
  it("refuses an insertion that would pass maxLength", () => {
    expect(spliceText("abcd", 4, 4, "😀", 5)).toBeNull(); // 4 + 2 > 5
    expect(spliceText("abc", 3, 3, "😀", 5)).toEqual({ value: "abc😀", caret: 5 });
    expect(spliceText("abcd", 0, 4, "😀", 5)).toEqual({ value: "😀", caret: 2 }); // a selection frees room
  });
});

/** Just enough of a textarea for the helper: value, selection, focus. */
function fakeField(value: string, start: number, end = start) {
  const el = {
    value,
    selectionStart: start as number | null,
    selectionEnd: end as number | null,
    focus: vi.fn(),
    setSelectionRange: vi.fn((s: number, e: number) => {
      el.selectionStart = s;
      el.selectionEnd = e;
    }),
  };
  return el;
}

describe("insertAtCursor / replaceRangeInField", () => {
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const flush = () => frames.splice(0).forEach((cb) => cb(0));
  const asField = (el: ReturnType<typeof fakeField>) => el as unknown as HTMLTextAreaElement;

  it("calls the state setter with the new value, then restores focus and the caret after the emoji", () => {
    const el = fakeField("hello world", 5);
    const set = vi.fn();
    const after = vi.fn();
    expect(insertAtCursor(asField(el), "😀", set, { onAfter: after })).toBe(true);
    expect(set).toHaveBeenCalledWith("hello😀 world");
    expect(el.setSelectionRange).not.toHaveBeenCalled(); // waits for React to render
    flush();
    expect(el.focus).toHaveBeenCalled();
    expect(el.setSelectionRange).toHaveBeenCalledWith(7, 7);
    expect(after).toHaveBeenCalled();
  });

  it("replaces the selected text", () => {
    const el = fakeField("hello world", 6, 11);
    const set = vi.fn();
    insertAtCursor(asField(el), "🌍", set);
    expect(set).toHaveBeenCalledWith("hello 🌍");
  });

  it("appends when the field has no selection info", () => {
    const el = fakeField("abc", 0);
    el.selectionStart = null;
    el.selectionEnd = null;
    const set = vi.fn();
    insertAtCursor(asField(el), "😀", set);
    expect(set).toHaveBeenCalledWith("abc😀");
  });

  it("appends to the fallback value when the field is not mounted", () => {
    const set = vi.fn();
    expect(insertAtCursor(null, "😀", set, { fallbackValue: "hi " })).toBe(true);
    expect(set).toHaveBeenCalledWith("hi 😀");
    flush(); // no element: nothing to focus, no crash
  });

  it("does nothing, and says so, when the emoji does not fit", () => {
    const el = fakeField("abcd", 4);
    const set = vi.fn();
    expect(insertAtCursor(asField(el), "😀", set, { maxLength: 5 })).toBe(false);
    expect(set).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
  });

  it("replaces a typed ':smi' range with the emoji", () => {
    const el = fakeField("say :smi now", 8);
    const set = vi.fn();
    replaceRangeInField(asField(el), 4, 8, "😄", set);
    expect(set).toHaveBeenCalledWith("say 😄 now");
    flush();
    expect(el.setSelectionRange).toHaveBeenCalledWith(6, 6);
  });
});

describe("insertEmojiInEditor (Tiptap)", () => {
  it("focuses the editor and inserts the emoji at the selection", () => {
    const run = vi.fn(() => true);
    const insertContent = vi.fn(() => ({ run }));
    const focus = vi.fn(() => ({ insertContent }));
    const editor = { chain: () => ({ focus }) } as unknown as Parameters<typeof insertEmojiInEditor>[0];
    expect(insertEmojiInEditor(editor, "😀")).toBe(true);
    expect(focus).toHaveBeenCalled();
    expect(insertContent).toHaveBeenCalledWith("😀");
    expect(run).toHaveBeenCalled();
  });
  it("does nothing without an editor", () => {
    expect(insertEmojiInEditor(null, "😀")).toBe(false);
  });
});
