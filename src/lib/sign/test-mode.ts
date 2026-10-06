// ============================================================
// Template test mode (F-10): "send yourself a preview document that is clearly marked TEST". The pure half, shared by the server
// (service/test-mode.ts) and the template page's dialog: which roles of a template need a person, which addresses count as "the
// person's own", and who sits where on a test document. No I/O.
//
// A test document is a real document in every way that matters for trying the flow (the template's real version and form, the real
// signing page, the real sealing) and different in four ways: it says TEST (every page, every message, the signing page, the list),
// it is never counted against the monthly limit, it tells no webhook or automation about itself, and it is kept 30 days.
// ============================================================

import { fieldsForRole } from "./rules";
import type { PlacedField } from "./pdf/types";
import type { FormDefinition } from "./forms/types";
import type { SignRole } from "./types";

/** How long a completed test document is kept (the database enforces it: migration 170). */
export const TEST_RETENTION_DAYS = 30;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The roles of a template that need a person on a document: a role with something to fill or sign, or a part of the form. */
export function rolesNeedingPeople(roles: readonly SignRole[], fields: readonly PlacedField[], form: FormDefinition | null): SignRole[] {
  return roles.filter((r) => fieldsForRole(fields, r.key).length > 0 || (form?.parts.some((p) => p.role === r.key) ?? false));
}

/** An address in lower case with spaces trimmed. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** `ali+merchant@kedai.example` is `ali@kedai.example`: the part after a plus sign in the local part names a folder of the same mailbox. */
export function mailbox(email: string): string {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  const local = e.slice(0, at);
  const plus = local.indexOf("+");
  return `${plus > 0 ? local.slice(0, plus) : local}${e.slice(at)}`;
}

/**
 * Is `candidate` one of the person's own addresses? An address they have (their sign-in, their profile) or the same mailbox with a
 * `+tag` (`gokula+director@vircle.example`), which is how one person can hold two places of a document that signs in order.
 */
export function isOwnAddress(candidate: string, own: readonly string[]): boolean {
  const c = normalizeEmail(candidate);
  if (!EMAIL_RE.test(c) || c.length > 254) return false;
  const boxes = new Set(own.filter(Boolean).map(mailbox));
  return boxes.has(mailbox(c));
}

export interface TestSigner {
  roleKey: string;
  kind: "signer" | "filler";
  fullName: string;
  email: string;
  orderNo: number;
}

export interface TestPlan {
  signers: TestSigner[];
  /** The template signs in order but one address holds more than one place, which a document in order refuses: the test ignores the order. */
  orderIgnored: boolean;
}

export type TestPlanError = { code: "test_email_not_yours" | "test_no_roles"; role?: string };

/**
 * Who sits where on a test document. Every role that needs a person gets `emails[role]` or else `defaultEmail`; each must be one of the
 * person's own addresses. The names say which role they play when one person holds several. Roles come out in the template's order.
 */
export function planTestSigners(args: {
  roles: readonly SignRole[];
  fields: readonly PlacedField[];
  form: FormDefinition | null;
  signInOrder: boolean;
  /** Who the person is, for the name on the document. */
  name: string;
  defaultEmail: string;
  own: readonly string[];
  emails?: Readonly<Record<string, string | undefined>>;
}): { ok: true; plan: TestPlan } | { ok: false; error: TestPlanError } {
  const needed = rolesNeedingPeople(args.roles, args.fields, args.form);
  if (needed.length === 0) return { ok: false, error: { code: "test_no_roles" } };
  const signers: TestSigner[] = [];
  for (const [i, role] of needed.entries()) {
    const email = normalizeEmail(args.emails?.[role.key] || args.defaultEmail);
    if (!isOwnAddress(email, args.own)) return { ok: false, error: { code: "test_email_not_yours", role: role.key } };
    signers.push({ roleKey: role.key, kind: role.kind, fullName: needed.length > 1 ? `${args.name} (${role.label})` : args.name, email, orderNo: i + 1 });
  }
  const distinct = new Set(signers.map((s) => s.email)).size === signers.length;
  const orderIgnored = args.signInOrder && !distinct;
  return { ok: true, plan: { signers, orderIgnored } };
}

/** A name to put on the test document when the profile has none: the part of the address before the @. */
export const nameFromEmail = (email: string): string => normalizeEmail(email).split("@")[0] || "Tester";
