import { isResendConfigured, sendEmail } from "./resend";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildPasswordResetEmail(url: string): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = "Reset your password";
  const text = [
    "You requested a password reset.",
    "",
    url,
    "",
    "This link can be used once and expires after 1 hour. If you did not request this, you can safely ignore it.",
  ].join("\n");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">
      <p style="font-size:15px;line-height:1.5;">You requested a password reset. Click below to choose a new password:</p>
      <p style="margin:24px 0;">
        <a href="${escapeHtml(url)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;">Reset password</a>
      </p>
      <p style="font-size:13px;color:#666;line-height:1.5;">This link can be used once and expires after 1 hour. If you did not request this, you can safely ignore it.</p>
    </div>
  `.trim();

  return { subject, html, text };
}

/** Returns true when the email was handed to the provider. Never throws. */
export async function sendPasswordResetEmail(args: {
  to: string;
  url: string;
}): Promise<boolean> {
  if (!isResendConfigured()) return false;
  try {
    const { subject, html, text } = buildPasswordResetEmail(args.url);
    await sendEmail({ to: args.to, subject, html, text });
    return true;
  } catch (err) {
    console.error(
      "[password-reset-email] send failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
