// ============================================================
// Compliance requests, the personal closure form link: how each channel carries it. Pure.
//
//   whatsapp      an interactive call-to-action message (a button that opens the address), only inside the 24-hour customer-service window
//   messenger     a button template (a "web_url" button)
//   instagram     a generic template with a "web_url" button
//   email, gmail  an HTML email with a button (and the address in text under it)
//   vircle_chat   plain text "Account closure form: <address>" (the gateway takes text)
//   web_widget    NOT possible: the web chat's visitor reads the conversation's message rows directly, so the address would have to be stored in them,
//                 and the rule is that it never is. The agent gets Copy link.
//   anything else no channel
//
// Where a channel cannot show a button the message is the plain line, and the report says so. A channel that cannot be used at all (or WhatsApp outside the
// window) leaves the link made but not sent, with a reason.
// ============================================================

import type { NotSentReason } from "./types";

export type CardMode = "whatsapp_cta" | "messenger_button" | "instagram_generic" | "email_button" | "text";

export type DeliveryPlan = { send: true; mode: CardMode; card: boolean } | { send: false; reason: NotSentReason };

/** The WhatsApp rule: free-form messages only go within 24 hours of the customer's last message. Passed in, so this stays pure. */
export function planDelivery(channel: string | null | undefined, opts: { whatsappWindowOpen: boolean }): DeliveryPlan {
  switch (channel) {
    case "whatsapp":
      return opts.whatsappWindowOpen ? { send: true, mode: "whatsapp_cta", card: true } : { send: false, reason: "window_expired" };
    case "messenger":
      return { send: true, mode: "messenger_button", card: true };
    case "instagram":
      return { send: true, mode: "instagram_generic", card: true };
    case "email":
    case "gmail":
      return { send: true, mode: "email_button", card: true };
    case "vircle_chat":
      return { send: true, mode: "text", card: false };
    case "web_widget":
      return { send: false, reason: "channel_unsupported" };
    default:
      return { send: false, reason: "no_channel" };
  }
}
