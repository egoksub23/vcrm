import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ADMIN_ERROR_CODES, adminErrorKey } from "@/lib/sign/client/admin-errors";
import { issueKey, reasonKey } from "@/lib/sign/client/registration-admin";
import { leaves, placeholders, readAdminMessages, REGISTER_LOCALES, type RegisterLocale, type Tree } from "@/lib/sign/client/register-test-messages";
import { REGISTRATION_REASONS, REGISTRATION_STATUSES, ASK_LEVELS } from "@/lib/sign/registration/types";

// Settings > Doc Sign > Registration forms words everything through next-intl (`Sign.admin.registration`). This holds the
// translations to what the code asks for: every key the two screens use exists in all four languages with the same
// placeholders, so a raw key can never show. Skipped while the messages are neither in the message files nor in the
// fragments (SIGN_I18N_FRAGMENTS, see lib/sign/client/register-test-messages.ts).

const messages = readAdminMessages();
const run = messages ? describe : describe.skip;

const registration = (l: RegisterLocale) => leaves((messages![l] as Tree).registration);

/** Keys asked for by name: t("a.b"), on `Sign.admin.registration`. */
function staticKeys(): string[] {
  const keys = new Set<string>();
  for (const file of ["registration-section.tsx", "registration-form-dialog.tsx"]) {
    for (const m of readFileSync(join(process.cwd(), "src", "components", "settings", "sign", file), "utf8").matchAll(/\bt\(\s*"([^"$]+)"/g)) keys.add(m[1]);
  }
  return [...keys];
}

/** The families asked for with a variable. Each value the variable can take. */
const FAMILIES: string[] = [
  ...REGISTRATION_STATUSES.map((s) => `status.${s}`),
  ...[...REGISTRATION_REASONS, "generic"].map((r) => `reasons.${r}`),
  ...ASK_LEVELS.map((a) => `ask.${a}`),
  ...["full_name", "company", "phone", "email"].map((d) => `detail.${d}`),
  // the problems the editor says before sending (client/registration-admin.ts toPayload)
  "problems.name.required",
  "problems.name.too_long",
  "problems.template.required",
  "problems.applicantRole.required",
  "problems.others.incomplete",
  "problems.others.invalid",
  "problems.dailyCap.invalid",
];

/** The issues a form can have: the ones it words, and the sentence for any other. */
const ISSUES = [
  "no_template",
  "template_not_active",
  "template_has_no_version",
  "no_applicant_role",
  "applicant_role_unknown",
  "signer_role",
  "no_signer",
  "role_without_person",
  "part_without_person",
  "signer_without_signature",
  "signer_name",
  "signer_email",
  "signer_phone",
  "too_many_signers",
  "order_not_unique",
  "same_person_twice",
];

run("the registration forms screens' words", () => {
  it("has, in every language, every key the screens ask for", () => {
    const wanted = [...staticKeys(), ...FAMILIES, ...ISSUES.map((i) => `issues.${i}`), "issues.generic"];
    expect(wanted.length).toBeGreaterThan(100);
    for (const l of REGISTER_LOCALES) {
      const have = registration(l);
      for (const key of wanted) expect(have.has(key), `${l}: ${key}`).toBe(true);
    }
  });

  it("words every reason, issue and error code the code can produce, and never asks for a key it lacks", () => {
    const have = registration("en");
    for (const r of REGISTRATION_REASONS) expect(have.has(reasonKey(r)), r).toBe(true);
    expect(have.has(reasonKey("unheard_of"))).toBe(true);
    for (const i of ISSUES) expect(have.has(issueKey(i)), i).toBe(true);
    expect(have.has(issueKey("bad_role_key"))).toBe(true);
    // the codes the routes answer with, in Sign.admin.errors
    const errors = leaves((messages!.en as Tree).errors);
    for (const code of ["form_not_found", "form_not_ready", "invalid_form", "tag_not_found", "slug_unavailable"]) {
      expect(ADMIN_ERROR_CODES as readonly string[], code).toContain(code);
      expect(errors.has(code), code).toBe(true);
      expect(adminErrorKey(code)).toBe(`errors.${code}`);
    }
    expect(leaves((messages!.en as Tree).tabs).has("registration")).toBe(true);
  });

  it("has the same keys and the same placeholders in every language, and no empty sentence", () => {
    const en = registration("en");
    for (const l of REGISTER_LOCALES.filter((x): x is Exclude<RegisterLocale, "en"> => x !== "en")) {
      const other = registration(l);
      expect([...other.keys()].sort(), l).toEqual([...en.keys()].sort());
      for (const [key, text] of en) {
        expect(placeholders(other.get(key)!), `${l}: ${key}`).toEqual(placeholders(text));
        expect(other.get(key)!.trim().length, `${l}: ${key}`).toBeGreaterThan(0);
      }
      expect(leaves((messages![l] as Tree).tabs).has("registration"), l).toBe(true);
    }
  });

  it("has real Bahasa Melayu, Chinese and Korean, not English copies", () => {
    const en = registration("en");
    for (const l of ["ms", "zh", "ko"] as const) {
      const other = registration(l);
      const same = [...en].filter(([k, v]) => other.get(k) === v && v.split(" ").length > 3);
      expect(same.map(([k]) => k), l).toEqual([]);
    }
  });
});
