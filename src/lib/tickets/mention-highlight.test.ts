import { describe, expect, it } from "vitest";

import { highlightMentions } from "./mention-highlight";

const people = ["Vicky Tan", "Amezee", "Gokula Krishnan Subramaniam"];
const teams = ["Support Team", "Master Access - All Channels"];

describe("highlightMentions", () => {
  it("marks a picked person and keeps the rest as text", () => {
    expect(highlightMentions("@Vicky Tan  can you look into this?", people, teams)).toEqual([
      { text: "@Vicky Tan", kind: "person" },
      { text: "  can you look into this?", kind: "text" },
    ]);
  });

  it("marks a team differently from a person", () => {
    const segs = highlightMentions("hi @Support Team and @Amezee please check", people, teams);
    expect(segs.filter((s) => s.kind !== "text")).toEqual([
      { text: "@Support Team", kind: "team" },
      { text: "@Amezee", kind: "person" },
    ]);
    expect(segs.map((s) => s.text).join("")).toBe("hi @Support Team and @Amezee please check");
  });

  it("does not mark a half-typed name", () => {
    expect(highlightMentions("@Vic", people, teams)).toEqual([{ text: "@Vic", kind: "text" }]);
    expect(highlightMentions("@Vicky", people, teams)).toEqual([{ text: "@Vicky", kind: "text" }]);
  });

  it("does not mark a name glued to more letters or an email-like @", () => {
    expect(highlightMentions("@Amezeeeee", people, teams)).toEqual([{ text: "@Amezeeeee", kind: "text" }]);
    expect(highlightMentions("mail me at x@Amezee", people, teams)).toEqual([{ text: "mail me at x@Amezee", kind: "text" }]);
  });

  it("is case-insensitive, allows trailing punctuation and prefers the longest name", () => {
    const segs = highlightMentions("@vicky tan, thanks. @MASTER ACCESS - ALL CHANNELS!", people, teams);
    expect(segs.filter((s) => s.kind !== "text").map((s) => [s.text, s.kind])).toEqual([
      ["@vicky tan", "person"],
      ["@MASTER ACCESS - ALL CHANNELS", "team"],
    ]);
  });

  it("copes with empty input, no names and regex characters in names", () => {
    expect(highlightMentions("", people, teams)).toEqual([]);
    expect(highlightMentions("@Amezee", [], [])).toEqual([{ text: "@Amezee", kind: "text" }]);
    expect(highlightMentions("@Ops (EU)+ team", ["Ops (EU)+ team"], [])).toEqual([{ text: "@Ops (EU)+ team", kind: "person" }]);
  });
});
