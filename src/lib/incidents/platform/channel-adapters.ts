// WhatsApp, SMS and push: the other ways a notice can leave Halo (alongside email). Each is an adapter the engine already knows how to call, so rules, roles and the
// message log are unchanged. A person who prefers one of these is told on it AND by email (see addressesFor), so a notice is never lost to a missing app or an
// unapproved template.
//
//   WhatsApp  a template message through the school's connected WhatsApp number. Meta only allows a business to start a conversation with an approved
//             template, so the school sets the template's name (Setup, Channels). The template needs two body variables: {{1}} the headline, {{2}} the links.
//             Example body:  "Halo incident notice: {{1}}. Links: {{2}}"
//   SMS       a POST to a bridge address (INCIDENT_SMS_URL, bearer INCIDENT_SMS_TOKEN) with { to, text }. Halo has no SMS provider of its own: point the bridge at
//             whichever the school uses.
//   Push      the Vircle send-mobile-alert API (INCIDENT_PUSH_API_URL, INCIDENT_PUSH_API_KEY, INCIDENT_PUSH_API_STAGE = uat | prod), by phone number.
//
// A channel that is not set up answers "not retryable", so nothing keeps retrying a notice that can never go that way.

import type { Notice } from "./messages";
import type { ChannelAdapter, SendResult } from "./adapters";
import type { ChannelKind } from "./roles";

// ---- pure helpers -----------------------------------------------------------------------------------------------

/** One line, single spaces: what a WhatsApp template variable allows (no new lines, tabs or runs of spaces). */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function urlsOf(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s)>"']+/g) ?? [])];
}

/** The two template variables: the headline, and the links (acknowledge first, when the notice has one). */
export function whatsappParams(notice: Notice): [string, string] {
  return [oneLine(notice.subject, 200), oneLine(urlsOf(notice.text).join(" "), 600) || "-"];
}

/** A short text for SMS and push: the headline, then the first link. */
export function shortText(notice: Notice, max = 300): string {
  const first = urlsOf(notice.text)[0];
  return oneLine(first ? `${notice.subject} ${first}` : notice.subject, max);
}

/** Digits only, international format (country code first). Null when it does not look like one. */
export function internationalDigits(phone: string): string | null {
  const digits = phone.replace(/[^\d]/g, "");
  if (phone.trim().startsWith("0") && !phone.trim().startsWith("00")) return null; // a local number: the country is not known
  const d = digits.startsWith("00") ? digits.slice(2) : digits;
  return d.length >= 8 && d.length <= 15 ? d : null;
}

export interface ChannelSetup {
  whatsapp: boolean;
  sms: boolean;
  push: boolean;
}

/** The channels a school can use right now: email always, the others when they are set up. */
export function availableChannels(setup: ChannelSetup): ChannelKind[] {
  return ["email", ...(setup.whatsapp ? (["whatsapp"] as const) : []), ...(setup.sms ? (["sms"] as const) : []), ...(setup.push ? (["push"] as const) : [])];
}

const failure = (error: string, retryable: boolean): SendResult => ({ ok: false, error, retryable });
const retryableStatus = (status: number) => status === 429 || status >= 500;

// ---- WhatsApp ---------------------------------------------------------------------------------------------------

export interface WhatsAppDeps {
  loadConfig(accountId: string): Promise<{ phoneNumberId: string; accessToken: string; enabled: boolean } | null>;
  loadTemplate(accountId: string): Promise<{ name: string; language: string } | null>;
  sendTemplate(args: { phoneNumberId: string; accessToken: string; to: string; templateName: string; language: string; params: string[] }): Promise<{ messageId: string }>;
}

export function createWhatsAppAdapter(deps: WhatsAppDeps): ChannelAdapter {
  return {
    channel: "whatsapp",
    async send({ accountId, to, notice }) {
      const [config, template] = await Promise.all([deps.loadConfig(accountId), deps.loadTemplate(accountId)]);
      if (!config || !config.enabled) return failure("WhatsApp is not connected for this school", false);
      if (!template?.name) return failure("No WhatsApp template is set up for incident notices (Setup, Channels)", false);
      const digits = internationalDigits(to);
      if (!digits) return failure("The phone number needs the country code, for example +60 12 345 6789", false);
      try {
        const sent = await deps.sendTemplate({ phoneNumberId: config.phoneNumberId, accessToken: config.accessToken, to: digits, templateName: template.name, language: template.language || "en", params: whatsappParams(notice) });
        return { ok: true, providerRef: sent.messageId };
      } catch (err) {
        const message = err instanceof Error ? err.message : "WhatsApp send failed";
        // A refused template, number or token will not get better by trying again; a timeout or a server error might.
        return failure(oneLine(message, 200), /\b(429|5\d\d)\b|timeout|timed out|network|fetch failed|ECONN/i.test(message));
      }
    },
  };
}

// ---- SMS --------------------------------------------------------------------------------------------------------

export interface HttpDeps {
  url: string | null;
  secret: string | null;
  fetch?: typeof fetch;
}

export function createSmsAdapter(deps: HttpDeps): ChannelAdapter {
  return {
    channel: "sms",
    async send({ accountId, to, notice }) {
      if (!deps.url || !deps.secret) return failure("SMS is not set up on this server", false);
      const digits = internationalDigits(to);
      if (!digits) return failure("The phone number needs the country code, for example +60 12 345 6789", false);
      try {
        const res = await (deps.fetch ?? fetch)(deps.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${deps.secret}` },
          body: JSON.stringify({ to: `+${digits}`, text: shortText(notice, 300), account_id: accountId }),
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status >= 200 && res.status < 300) return { ok: true };
        return failure(`The SMS bridge answered ${res.status}`, retryableStatus(res.status));
      } catch {
        return failure("The SMS bridge could not be reached", true);
      }
    },
  };
}

// ---- push (Vircle mobile alert) -----------------------------------------------------------------------------------

export interface PushDeps extends HttpDeps {
  stage: "uat" | "prod" | null;
}

export function createPushAdapter(deps: PushDeps): ChannelAdapter {
  return {
    channel: "push",
    async send({ to, notice }) {
      if (!deps.url || !deps.secret || !deps.stage) return failure("Push alerts are not set up on this server", false);
      const digits = internationalDigits(to);
      if (!digits) return failure("The phone number needs the country code, for example +60 12 345 6789", false);
      try {
        const res = await (deps.fetch ?? fetch)(deps.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": deps.secret, "x-api-stage": deps.stage },
          body: JSON.stringify({ mobile_number: digits, subject: oneLine(notice.subject, 120), body: shortText(notice, 300) }),
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status >= 200 && res.status < 300) return { ok: true };
        const text = await res.text().catch(() => "");
        // No client has this phone number: nothing to retry.
        if (res.status === 404 && /ERA03/.test(text)) return failure("No app is registered to this phone number", false);
        return failure(`The push service answered ${res.status}`, retryableStatus(res.status));
      } catch {
        return failure("The push service could not be reached", true);
      }
    },
  };
}
