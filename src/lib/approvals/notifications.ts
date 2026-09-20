// Where a click on an approval notification goes. The database writes the
// notification (migration 084) with a fixed English title, so the target is
// read from the type and, for a decision, from the word for the item.

export type ApprovalNotificationType = "approval_requested" | "approval_decided";

export function isApprovalNotification(type: string): type is ApprovalNotificationType {
  return type === "approval_requested" || type === "approval_decided";
}

/**
 * The route for an approval notification: a reviewer opens the queue; a
 * proposer whose item was decided lands on the list it belongs to.
 */
export function approvalNotificationHref(type: ApprovalNotificationType, title: string): string {
  if (type === "approval_requested") return "/settings?tab=approvals";
  const t = title.toLowerCase();
  if (t.includes("snippet")) return "/settings?tab=quick-replies";
  if (t.includes("article")) return "/knowledge";
  if (t.includes("label")) return "/settings?tab=labels";
  return "/settings?tab=tags";
}
