import { describe, expect, it } from "vitest";

import { MailSendError, reasonDetail, reasonOfDetail, SEND_REASONS, technicalOfDetail } from "./send-reason";

describe("the detail of a failed delivery", () => {
  it("is a reason, then what the service said", () => {
    expect(reasonDetail("daily_limit", "Daily user sending quota exceeded.")).toBe("daily_limit: Daily user sending quota exceeded.");
    expect(reasonDetail("not_set_up")).toBe("not_set_up");
    expect(reasonDetail(null, "  Mail   service  not enabled ")).toBe("Mail service not enabled");
    expect(reasonDetail(null)).toBe("send failed");
    expect(reasonDetail("rate_limited", "x".repeat(500)).length).toBe(200);
  });

  it("reads back: every reason, with and without the service's words", () => {
    for (const r of SEND_REASONS) {
      expect(reasonOfDetail(r)).toBe(r);
      expect(reasonOfDetail(reasonDetail(r, "said something"))).toBe(r);
      expect(technicalOfDetail(reasonDetail(r, "said something"))).toBe("said something");
    }
  });

  it("does not take free text for a reason", () => {
    expect(reasonOfDetail("Resend 422: invalid recipient")).toBeNull();
    expect(reasonOfDetail("not_a_reason: x")).toBeNull();
    expect(reasonOfDetail("")).toBeNull();
    expect(reasonOfDetail(null)).toBeNull();
    expect(technicalOfDetail("Resend 422: invalid recipient")).toBe("Resend 422: invalid recipient");
  });

  it("is what a MailSendError says", () => {
    const e = new MailSendError("mailbox_reconnect", "token revoked");
    expect(e.message).toBe("mailbox_reconnect: token revoked");
    expect(e.reason).toBe("mailbox_reconnect");
    expect(new MailSendError(null, "odd").message).toBe("odd");
  });
});
