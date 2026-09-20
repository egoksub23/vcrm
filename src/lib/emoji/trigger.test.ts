import { describe, expect, it } from "vitest";

import { expandClosedShortcode, parseEmojiTrigger } from "./trigger";

const open = (text: string, caret = text.length) => parseEmojiTrigger(text, caret);

describe("parseEmojiTrigger (the ':' shortcut)", () => {
  it("accepts a colon and two or more shortcode characters", () => {
    expect(open(":smi")).toEqual({ start: 0, query: "smi" });
    expect(open(":+1")).toEqual({ start: 0, query: "+1" });
    expect(open(":-1")).toEqual({ start: 0, query: "-1" });
    expect(open(":thumbs_up")).toEqual({ start: 0, query: "thumbs_up" });
    expect(open(":100")).toEqual({ start: 0, query: "100" });
  });

  it("accepts it after whitespace, a newline or opening punctuation", () => {
    expect(open("hello :smi")).toEqual({ start: 6, query: "smi" });
    expect(open("line one\n:smi")).toEqual({ start: 9, query: "smi" });
    expect(open("(:smi")).toEqual({ start: 1, query: "smi" });
    expect(open('say "(:smi')).toEqual({ start: 6, query: "smi" });
  });

  it("uses the caret, not the end of the text", () => {
    expect(open("go :smi and more", 7)).toEqual({ start: 3, query: "smi" });
    expect(open("go :smi and more", 16)).toBeNull();
  });

  it("rejects a single character after the colon", () => {
    expect(open(":s")).toBeNull();
    expect(open(":")).toBeNull();
    expect(open("hi :")).toBeNull();
  });

  it("rejects times, URLs and a colon inside a word", () => {
    expect(open("10:30")).toBeNull();
    expect(open("at 10:30pm")).toBeNull();
    expect(open("https://example.com")).toBeNull();
    expect(open("http://x")).toBeNull();
    expect(open("a:b")).toBeNull();
    expect(open("foo:bar")).toBeNull();
    expect(open("key:value")).toBeNull();
    expect(open("::smi")).toBeNull();
  });

  it("rejects text that is not a shortcode character", () => {
    expect(open(":sm!")).toBeNull();
    expect(open(":smi ")).toBeNull();
    expect(open(":smi.")).toBeNull();
  });

  it("works with emoji (surrogate pairs) earlier in the text", () => {
    const text = "😀😀 :smi";
    expect(open(text)).toEqual({ start: 5, query: "smi" });
  });
});

describe("expandClosedShortcode (a finished ':smile:')", () => {
  const codes: Record<string, string> = { smile: "😄", "+1": "👍", thumbs_up: "👍" };
  const resolve = (c: string) => codes[c];

  it("replaces a known shortcode when the closing colon is typed", () => {
    expect(expandClosedShortcode(":smile:", 7, resolve)).toEqual({ value: "😄", caret: 2, emoji: "😄" });
    expect(expandClosedShortcode("ok :+1: then", 7, resolve)).toEqual({ value: "ok 👍 then", caret: 5, emoji: "👍" });
  });

  it("is case-insensitive", () => {
    expect(expandClosedShortcode(":SMILE:", 7, resolve)?.emoji).toBe("😄");
  });

  it("leaves an unknown shortcode alone", () => {
    expect(expandClosedShortcode(":nope:", 6, resolve)).toBeNull();
  });

  it("does not fire for times, URLs, or when the caret is not right after the colon", () => {
    expect(expandClosedShortcode("10:30:45", 8, resolve)).toBeNull();
    expect(expandClosedShortcode("https://smile:", 14, resolve)).toBeNull();
    expect(expandClosedShortcode("a:smile:", 8, resolve)).toBeNull();
    expect(expandClosedShortcode(":smile: x", 3, resolve)).toBeNull();
  });
});
