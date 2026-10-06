import { describe, expect, it } from "vitest";

import { certificateLabels, eventSentence, HIDDEN_EVENTS } from "./certificate-words";
import { EVENT_TYPES, SIGN_LOCALES } from "./types";

describe("certificate labels", () => {
  it("exist in every language with every label filled", () => {
    const en = certificateLabels("en");
    for (const l of SIGN_LOCALES) {
      const labels = certificateLabels(l);
      expect(Object.keys(labels).sort()).toEqual(Object.keys(en).sort());
      for (const [k, v] of Object.entries(labels)) expect(v.length, `${l}.${k}`).toBeGreaterThan(0);
    }
  });
});

describe("eventSentence", () => {
  const names = { actor: "Ali bin Ahmad", sender: "Gokula" };

  it("words each kind of event, naming the people", () => {
    expect(eventSentence("signed", "en", names)).toBe("Ali bin Ahmad signed");
    expect(eventSentence("sent", "en", names)).toBe("Gokula sent the document");
    expect(eventSentence("signed", "ms", names)).toBe("Ali bin Ahmad menandatangani");
    expect(eventSentence("completed", "zh", names)).toBe("文件已完成");
    expect(eventSentence("declined", "ko", names)).toBe("Ali bin Ahmad님이 서명을 거부했습니다");
  });

  it("leaves out autosaves and retries", () => {
    for (const t of HIDDEN_EVENTS) expect(eventSentence(t, "en", names)).toBeNull();
  });

  it("has a sentence in every language for every event a certificate can show", () => {
    for (const type of EVENT_TYPES) {
      if (HIDDEN_EVENTS.has(type)) continue;
      for (const l of SIGN_LOCALES) expect(eventSentence(type, l, names), `${l}.${type}`).toEqual(expect.any(String));
    }
  });

  it("returns nothing for an unknown event", () => {
    expect(eventSentence("mystery", "en", names)).toBeNull();
  });
});
