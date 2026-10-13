import { describe, expect, it } from "vitest";

import { COMPLIANCE_NOTIFICATION_TYPES, complianceNotificationHref, isComplianceNotification } from "./notification-href";

const ID = "3b241101-e2bb-4255-8caf-4136c566a962";

describe("compliance notifications", () => {
  it("knows the three types, including the closure form that came back (migration 185)", () => {
    expect([...COMPLIANCE_NOTIFICATION_TYPES]).toEqual(["compliance_clock", "compliance_signoff", "compliance_form"]);
    expect(isComplianceNotification("compliance_form")).toBe(true);
    expect(isComplianceNotification("compliance_clock")).toBe(true);
    expect(isComplianceNotification("ticket_updated")).toBe(false);
    expect(isComplianceNotification("")).toBe(false);
  });

  it("opens the request, or the list when the request is gone", () => {
    expect(complianceNotificationHref(ID)).toBe(`/compliance/${ID}`);
    expect(complianceNotificationHref(null)).toBe("/compliance");
    expect(complianceNotificationHref(undefined)).toBe("/compliance");
    expect(complianceNotificationHref("")).toBe("/compliance");
    expect(complianceNotificationHref("../admin")).toBe("/compliance");
  });
});
