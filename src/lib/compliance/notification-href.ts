// ============================================================
// Compliance requests: where a notification about a request goes when it is clicked. Pure; browser-safe.
//
//   compliance_clock    a request is near its regulatory hard stop (migration 183)
//   compliance_signoff  a request reached the Head of Compliance's sign-off (migration 184)
//   compliance_form     a customer filled in the personal closure form sent in a chat (migration 185)
//
// All three open the request they are about, or the list when the request is gone (the row's id is cleared when the request is deleted).
// ============================================================

export const COMPLIANCE_NOTIFICATION_TYPES = ["compliance_clock", "compliance_signoff", "compliance_form"] as const;

export const isComplianceNotification = (type: string): boolean => (COMPLIANCE_NOTIFICATION_TYPES as readonly string[]).includes(type);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The page a compliance notification opens. */
export const complianceNotificationHref = (requestId: string | null | undefined): string => (requestId && UUID_RE.test(requestId) ? `/compliance/${requestId}` : "/compliance");
