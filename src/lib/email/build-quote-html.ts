export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface QuotedMessage {
  senderLabel: string;
  senderEmail?: string | null;
  createdAt: string;
  contentHtml?: string | null;
  contentText?: string | null;
}

/**
 * Builds the "On <date>, <name> wrote: <quoted body>" block every real
 * email reply carries — appended (client-side, before send) below the
 * agent's own WYSIWYG content so it's part of the actual HTML mailed
 * out via Graph/Gmail, the way any mail client's own "Reply" already
 * quotes the message you're replying to. Falls back to the prior
 * message's plain text (escaped) when it has no stored HTML body.
 */
export function buildQuoteHtml(prior: QuotedMessage): string {
  const dateStr = new Date(prior.createdAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const who = prior.senderEmail
    ? `${escapeHtml(prior.senderLabel)} &lt;${escapeHtml(prior.senderEmail)}&gt;`
    : escapeHtml(prior.senderLabel);
  const body =
    prior.contentHtml ||
    `<p>${escapeHtml(prior.contentText || "").replace(/\n/g, "<br>")}</p>`;

  return [
    '<div style="margin-top:16px;padding-left:12px;border-left:2px solid #e4e4ec;color:#6b7280;font-size:12.5px;font-family:sans-serif;">',
    `<div>On ${escapeHtml(dateStr)}, ${who} wrote:</div>`,
    `<div style="margin-top:6px;">${body}</div>`,
    "</div>",
  ].join("");
}
