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

  it("lists an upload by the file's name and the start of its fingerprint, in every language", () => {
    const detail = { field: "ssm", name: "Company Extract.pdf", size: 1234, hash: "0123456789abcdef" };
    expect(eventSentence("uploaded", "en", names, { detail })).toBe("Ali bin Ahmad uploaded Company Extract.pdf (fingerprint 0123456789abcdef)");
    expect(eventSentence("uploaded", "ms", names, { detail })).toBe("Ali bin Ahmad memuat naik Company Extract.pdf (cap jari 0123456789abcdef)");
    expect(eventSentence("uploaded", "zh", names, { detail })).toContain("Company Extract.pdf");
    expect(eventSentence("uploaded", "ko", names, { detail })).toContain("0123456789abcdef");
    expect(eventSentence("upload_removed", "en", names, { detail })).toBe("Ali bin Ahmad removed the upload Company Extract.pdf");
    // a name with a line break stays on one line
    expect(eventSentence("uploaded", "en", names, { detail: { ...detail, name: "a\nb.pdf" } })).not.toContain("\n");
  });

  it("words an extended expiry with the new date in the workspace's time zone, or plainly without one", () => {
    const detail = { old: "2026-10-20T08:00:00.000Z", new: "2026-10-27T20:00:00.000Z" };
    expect(eventSentence("expiry_extended", "en", names, { detail, timeZone: "Asia/Kuala_Lumpur" })).toBe("Gokula extended the expiry date to 28 Oct 2026");
    expect(eventSentence("expiry_extended", "en", names)).toBe("Gokula extended the expiry date");
    expect(eventSentence("expiry_extended", "ms", names, { detail })).toContain("Gokula melanjutkan tarikh tamat tempoh kepada");
  });

  it("keeps progress, saves and the contact being updated off the certificate", () => {
    for (const type of ["saved", "part_completed", "part_reopened", "writeback"]) {
      for (const l of SIGN_LOCALES) expect(eventSentence(type, l, names, { detail: { field: "company", old: "Secret", new: "Other" } }), `${l}.${type}`).toBeNull();
    }
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
