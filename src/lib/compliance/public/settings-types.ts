// ============================================================
// Compliance requests, the public forms' settings and the page's view: the shapes the screens share with the server. No I/O and no Node imports, so the
// browser may import this file (the services that fill them are settings.ts and service.ts).
// ============================================================

import type { CustomerLocale } from "../types";
import type { PublicType } from "./validate";

export interface PublicFormSettings {
  typeKey: PublicType;
  /** The form has been set up (it has an address). */
  exists: boolean;
  enabled: boolean;
  slug: string | null;
  notice: Partial<Record<CustomerLocale, string>>;
  turnstile: boolean;
  maxAmount: number;
  /** null: the built-in list of Malaysian banks. */
  banks: string[] | null;
  /** The type is active and carries every field the form fills; without it the form cannot be turned on. */
  ready: boolean;
}

export interface PublicFormsAnswer {
  forms: PublicFormSettings[];
  /** The operator has set both Turnstile keys, so the switch means something. */
  turnstileAvailable: boolean;
}

export interface PublicFormPatch {
  enabled?: boolean;
  notice?: Record<string, unknown>;
  turnstile?: boolean;
  maxAmount?: number;
  /** One bank per line, or a list; null or an empty list: the built-in list. */
  banks?: string | string[] | null;
  /** Give the form a new address (the old one stops working). */
  regenerateSlug?: boolean;
}

/** What the page needs, safe to hand to the browser (no secret, nothing of any case). */
export interface PublicView {
  slug: string;
  type: PublicType;
  workspace: { name: string; logoUrl: string | null };
  /** The extra text the workspace wants shown above the form, by language. */
  notice: Partial<Record<CustomerLocale, string>>;
  maxAmount: number;
  banks: string[];
  /** The practice target in days a closure is told ("We aim to complete closure within N days"). */
  targetDays: number | null;
  token: string;
  /** The Turnstile site key when the check is on for this form, else null. */
  captchaKey: string | null;
  /** The visitor holds a current session (they confirmed an address in the last hour). */
  sessionActive: boolean;
}
