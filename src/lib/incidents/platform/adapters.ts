// Channel adapters: how a notice actually leaves Halo. The engine only knows this interface, so WhatsApp, SMS and push are added later by writing
// another adapter and listing it in `defaultAdapters`, with no change to rules, roles or the message log.

import { realWorkspaceMailDeps, sendWorkspaceEmail, type WorkspaceMailDeps } from "@/lib/email/workspace-mail";
import type { Notice } from "./messages";
import type { ChannelKind } from "./roles";

export type SendResult =
  | { ok: true; providerRef?: string | null }
  /** `retryable: false` for "there is no way to send at all": retrying would only repeat the failure. */
  | { ok: false; error: string; retryable: boolean };

export interface ChannelAdapter {
  channel: ChannelKind;
  send(args: { accountId: string; to: string; notice: Notice }): Promise<SendResult>;
}

/** Email, as the workspace: through its connected mailbox when it has one, else the platform sender. The same path every other Halo email takes. */
export function createEmailAdapter(deps: WorkspaceMailDeps = realWorkspaceMailDeps): ChannelAdapter {
  return {
    channel: "email",
    async send({ accountId, to, notice }) {
      const result = await sendWorkspaceEmail(accountId, { to, subject: notice.subject, html: notice.html, text: notice.text }, deps);
      if (result.status === "sent") return { ok: true, providerRef: result.from ? `via ${result.via}:${result.from}` : `via ${result.via}` };
      if (result.status === "not_configured") return { ok: false, error: result.detail ?? "No way to send email is set up for this workspace", retryable: false };
      return { ok: false, error: result.detail ?? "The email could not be sent", retryable: true };
    },
  };
}

export type AdapterMap = Partial<Record<ChannelKind, ChannelAdapter>>;

export function defaultAdapters(): AdapterMap {
  return { email: createEmailAdapter() };
}
