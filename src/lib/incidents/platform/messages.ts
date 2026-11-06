// The message an incident notice carries. Minimal on purpose (PDPA): the reference, the category, the severity and a link. Names, medical detail and
// anything about a child stay inside Halo; the link opens Halo (or a one-tap acknowledge page for people with no login).

export type NoticeReason = "raised" | "reminder" | "escalated" | "step_overdue" | "closed" | "test";

export interface NoticeInput {
  reference: string;
  categoryName: string;
  severityName: string;
  reason: NoticeReason;
  /** Opens the incident in Halo (sign-in required). */
  incidentUrl: string;
  /** One-tap acknowledge page, when the notice asks for an acknowledgement. */
  ackUrl?: string | null;
  /** Reports made with a test key are marked, so nobody mistakes them for real. */
  isTest?: boolean;
  /** Name of the school or workspace, for the footer. */
  senderName?: string | null;
}

export interface Notice {
  subject: string;
  text: string;
  html: string;
}

const HEADLINE: Record<NoticeReason, string> = {
  raised: "An incident has been reported",
  reminder: "Reminder: an incident still needs you",
  escalated: "An incident has been escalated",
  step_overdue: "A required step on an incident is overdue",
  closed: "An incident has been closed",
  test: "This is a test notice",
};

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function buildNotice(input: NoticeInput): Notice {
  const test = input.isTest || input.reason === "test";
  const headline = HEADLINE[input.reason];
  const subject = `${test ? "[TEST] " : ""}[${input.severityName}] ${input.reference}: ${headline}`;

  const lines = [
    headline + (test ? " (test: nothing real happened)" : "") + ".",
    "",
    `Reference: ${input.reference}`,
    `Category: ${input.categoryName}`,
    `Severity: ${input.severityName}`,
    "",
    input.ackUrl ? `Acknowledge that you have seen this (no sign-in needed): ${input.ackUrl}` : "",
    `Open the incident (sign-in required): ${input.incidentUrl}`,
    "",
    "For privacy this message carries no names or medical detail. Those are in Halo.",
    input.senderName ? `Sent for ${input.senderName}.` : "",
  ].filter((l, i, all) => l !== "" || (all[i - 1] ?? "x") !== "");
  const text = lines.join("\n").trim();

  const button = (href: string, label: string, bg: string) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;background:${bg};color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;margin:0 8px 8px 0;">${escapeHtml(label)}</a>`;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">
      ${test ? '<p style="background:#fff4d6;border:1px solid #f0d58a;padding:8px 12px;border-radius:6px;font-size:13px;">Test notice. Nothing real happened.</p>' : ""}
      <p style="font-size:16px;line-height:1.4;font-weight:600;">${escapeHtml(headline)}</p>
      <table style="font-size:14px;line-height:1.6;border-collapse:collapse;">
        <tr><td style="color:#666;padding-right:12px;">Reference</td><td><strong>${escapeHtml(input.reference)}</strong></td></tr>
        <tr><td style="color:#666;padding-right:12px;">Category</td><td>${escapeHtml(input.categoryName)}</td></tr>
        <tr><td style="color:#666;padding-right:12px;">Severity</td><td>${escapeHtml(input.severityName)}</td></tr>
      </table>
      <p style="margin:20px 0 8px;">
        ${input.ackUrl ? button(input.ackUrl, "I have seen this", "#B42318") : ""}
        ${button(input.incidentUrl, "Open incident", "#344054")}
      </p>
      <p style="font-size:12px;color:#777;line-height:1.5;">For privacy this message carries no names or medical detail. Those are in Halo.${input.senderName ? ` Sent for ${escapeHtml(input.senderName)}.` : ""}</p>
    </div>`.trim();

  return { subject, text, html };
}
