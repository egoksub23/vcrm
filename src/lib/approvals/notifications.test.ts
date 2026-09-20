import { describe, expect, it } from "vitest";

import { approvalNotificationHref, isApprovalNotification } from "./notifications";

describe("approval notifications", () => {
  it("recognises the two types", () => {
    expect(isApprovalNotification("approval_requested")).toBe(true);
    expect(isApprovalNotification("approval_decided")).toBe(true);
    expect(isApprovalNotification("ticket_updated")).toBe(false);
  });

  it("sends a reviewer to the queue", () => {
    expect(approvalNotificationHref("approval_requested", "Approval needed: new snippet")).toBe(
      "/settings?tab=approvals",
    );
  });

  it("sends a proposer to the list the decided item belongs to", () => {
    expect(approvalNotificationHref("approval_decided", "Your snippet was approved")).toBe(
      "/settings?tab=quick-replies",
    );
    expect(approvalNotificationHref("approval_decided", "Your label was rejected")).toBe("/settings?tab=labels");
    expect(approvalNotificationHref("approval_decided", "Your tag was approved")).toBe("/settings?tab=tags");
    expect(approvalNotificationHref("approval_decided", "Your article was approved")).toBe("/knowledge");
  });
});
