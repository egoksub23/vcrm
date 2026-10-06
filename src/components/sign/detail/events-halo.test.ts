// How a Halo user's own turn reads in the history and on the certificate: identified by their Halo sign-in, never by a
// code, and never as a message that was sent (service/countersign.ts). The wording of both places, in every language.

import { describe, expect, it } from "vitest";

import { eventSentence, HIDDEN_EVENTS } from "@/lib/sign/certificate-words";
import { EVENT_TYPES, SIGN_LOCALES } from "@/lib/sign/types";

import { describeEvent, type DescribeContext, type SignEventRow } from "./events";

const ctx: DescribeContext = { signers: [{ id: "s1", full_name: "Gokula", order_no: 2 }], signInOrder: true, userName: (id) => (id === "u1" ? "Gokula" : null), someone: "Someone", teammate: "A teammate" };
const row = (over: Partial<SignEventRow>): SignEventRow => ({ id: "e1", doc_seq: 1, signer_id: "s1", type: "code_verified", actor_type: "signer", actor_user_id: "u1", detail: {}, ip: null, device: null, created_at: "2026-10-06T09:00:00Z", ...over });

describe("the history of a document", () => {
  it("words a Halo sign-in as its own sentence, and a code entry as before", () => {
    expect(describeEvent(row({ detail: { method: "halo_login" } }), ctx).key).toBe("events.code_verified_halo");
    expect(describeEvent(row({ detail: { method: "halo_login" } }), ctx).values.actor).toBe("Gokula");
    expect(describeEvent(row({ detail: {} }), ctx).key).toBe("events.code_verified");
    expect(describeEvent(row({ detail: { method: "something_else" } }), ctx).key).toBe("events.code_verified");
  });

  it("knows the event of a link made from inside Halo", () => {
    expect(EVENT_TYPES).toContain("halo_link");
    expect(describeEvent(row({ type: "halo_link", actor_type: "user" }), ctx).key).toBe("events.halo_link");
  });
});

describe("the certificate", () => {
  const names = { actor: "Gokula", sender: "Sender" };
  const halo = { detail: { method: "halo_login" } };

  it("says the person was identified by their Halo sign-in, in every language, and names the method", () => {
    expect(eventSentence("code_verified", "en", names, halo)).toBe("Gokula was identified by their Halo sign-in (verification method: Halo login)");
    expect(eventSentence("code_verified", "ms", names, halo)).toContain("log masuk Halo");
    expect(eventSentence("code_verified", "zh", names, halo)).toContain("Halo 登录");
    expect(eventSentence("code_verified", "ko", names, halo)).toContain("Halo 로그인");
    for (const l of SIGN_LOCALES) {
      const text = eventSentence("code_verified", l, names, halo) ?? "";
      expect(text, l).toContain("Gokula");
      expect(text, l).not.toBe(eventSentence("code_verified", l, names));
    }
  });

  it("keeps the sentence about a code for a person who entered one", () => {
    expect(eventSentence("code_verified", "en", names)).toBe("Gokula entered the verification code");
    expect(eventSentence("code_verified", "en", names, { detail: { method: "email_code" } })).toBe("Gokula entered the verification code");
  });

  it("leaves the technical link event off the certificate (the history keeps it)", () => {
    expect(HIDDEN_EVENTS.has("halo_link")).toBe(true);
    for (const l of SIGN_LOCALES) expect(eventSentence("halo_link", l, names)).toBeNull();
  });
});
