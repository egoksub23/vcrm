import { describe, expect, it } from "vitest";

import { bodyFromText, cleanSender, parseAddress, parseEmailIn, senderAllowed, titleFromSubject } from "./email-intake";

describe("the sender", () => {
  it("reads a name and an address, or just an address", () => {
    expect(parseAddress('"Aiman Yusof" <Aiman@School.edu>')).toEqual({ name: "Aiman Yusof", email: "aiman@school.edu" });
    expect(parseAddress("<aiman@school.edu>")).toEqual({ name: null, email: "aiman@school.edu" });
    expect(parseAddress("aiman@school.edu")).toEqual({ name: null, email: "aiman@school.edu" });
    expect(parseAddress("not an address")).toBeNull();
    expect(parseAddress(42)).toBeNull();
  });

  it("accepts an address or a whole domain on the allowed list, and nobody on an empty list", () => {
    expect(senderAllowed(["aiman@school.edu"], "Aiman@school.edu")).toBe(true);
    expect(senderAllowed(["@school.edu"], "anyone@school.edu")).toBe(true);
    expect(senderAllowed(["@school.edu"], "anyone@evil-school.edu")).toBe(false);
    expect(senderAllowed(["@school.edu"], "anyone@sub.school.edu")).toBe(false);
    expect(senderAllowed([], "aiman@school.edu")).toBe(false);
  });

  it("cleans what the school types into the allowed list", () => {
    expect(cleanSender("  @School.edu ")).toBe("@school.edu");
    expect(cleanSender("Aiman@School.edu")).toBe("aiman@school.edu");
    expect(cleanSender("school.edu")).toBeNull();
    expect(cleanSender("@")).toBeNull();
  });
});

describe("the words", () => {
  it("takes the subject without Re: and Fwd:, on one line", () => {
    expect(titleFromSubject("RE: Fwd: Twisted   ankle at football")).toBe("Twisted ankle at football");
    expect(titleFromSubject("   ")).toBe("Incident reported by email");
    expect(titleFromSubject("x".repeat(500))).toHaveLength(200);
  });

  it("drops quoted replies and everything under 'On ... wrote:'", () => {
    const text = "Aiman fell during football.\r\n\r\n\r\n\r\nHe is with the nurse.\r\n> old quoted line\r\nOn Mon, 9 Nov 2026 at 10:00, Coach <c@school.edu> wrote:\r\n> more";
    expect(bodyFromText(text)).toBe("Aiman fell during football.\n\nHe is with the nurse.");
  });

  it("reads the JSON a mail service posts, under a few common field names", () => {
    expect(parseEmailIn({ from: "a@school.edu", subject: "Hi", text: "body", message_id: " <m1@x> " })).toEqual({ from: "a@school.edu", subject: "Hi", text: "body", messageId: "<m1@x>" });
    expect(parseEmailIn({ sender: "a@school.edu", plain: "p" })).toMatchObject({ text: "p", messageId: null });
    expect(parseEmailIn({ subject: "no sender" })).toBeNull();
    expect(parseEmailIn("nope")).toBeNull();
  });
});
