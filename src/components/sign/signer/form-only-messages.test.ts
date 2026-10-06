import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The words of a form WITHOUT a signature (migration 169) in the message files: every key this work package adds exists in all
// four languages, is not English copied over, and has the same ICU arguments as the English. The keys are merged from the fragment
// files by the orchestrator (sign_i18n_add.py); until then this test has nothing to check and skips.

type Tree = { [key: string]: unknown };

const AREAS: Record<string, string[]> = {
  signer: [
    "consent.titleForm",
    "fill.declineForm",
    "decline.titleForm",
    "decline.bodyForm",
    "decline.confirmForm",
    "end.sealingForm.title",
    "end.sealingForm.body",
    "end.sealingForm.slow",
    "end.completedForm.title",
    "end.completedForm.body",
    "end.completedForm.download",
    "end.completedForm.view",
    "end.completedForm.byEmail",
    "end.declinedForm.title",
    "end.declinedForm.you",
    "end.declinedForm.other",
    "end.notInvitedForm.title",
    "end.notInvitedForm.body",
    "others.titleForm",
    "others.invitedForm",
  ],
  signerForm: [
    "final.reviewSubmit",
    "final.readyReviewSubmit",
    "end.submitted.title",
    "end.submitted.thanks",
    "end.submitted.next",
    "end.submitted.waiting",
    "submitReview.title",
    "submitReview.parts",
    "submitReview.body",
    "submitReview.change",
    "submitReview.changePart",
    "submitReview.picture",
    "submitReview.notAnswered",
    "submitReview.sensitiveNote",
    "submitReview.back",
    "submitReview.submit",
    "submitReview.submitting",
    "submitReview.afterwards",
  ],
  send: [
    "steps.formFields",
    "new.templateFactsForm",
    "list.formBadge",
    "list.progressForm",
    "people.emptyForm",
    "people.needsOrderForm",
    "people.needsOrderOnForm",
    "people.needsOrderOffForm",
    "people.sameEmailOrderedForm",
    "review.orderedIntroForm",
    "review.allAtOnceForm",
    "review.codeOnForm",
    "review.sendForm",
    "review.sendNoteForm",
    "result.titleForm",
    "result.linkLabelForm",
    "result.privateWarningForm",
    "problems.no_person",
    "problems.form_mode_needs_a_form",
    "problems.form_mode_signature",
    "problems.form_mode_placement",
    "problems.form_mode_signer_role",
  ],
  detail: [
    "header.formChip",
    "header.inOrderForm",
    "actions.downloadRecord",
    "tabs.record",
    "viewer.noteRecord",
    "banner.waitingForm",
    "banner.waitingMoreForm",
    "banner.waitingNobodyForm",
    "banner.sealingForm",
    "banner.sealingNoteForm",
    "banner.completedOnForm",
    "banner.completedForm",
    "banner.completedNoteForm",
    "banner.declinedNoteForm",
    "events.createdForm",
    "events.sentForm",
    "events.viewedForm",
    "events.consentedForm",
    "events.submittedForm",
    "events.declinedForm",
    "events.sealedForm",
    "events.completedForm",
    "events.downloadedForm",
    "events.all_submitted",
  ],
  formBuilder: [
    "rolesPanel.title",
    "rolesPanel.hint",
    "rolesPanel.nameLabel",
    "rolesPanel.parts",
    "rolesPanel.remove",
    "rolesPanel.removeInUse",
    "rolesPanel.removeLast",
    "rolesPanel.add",
    "rolesPanel.limit",
  ],
  admin: [
    "library.formBadge",
    "library.new.introForm",
    "library.new.kindLegend",
    "library.new.kindFile",
    "library.new.kindFileHint",
    "library.new.kindForm",
    "library.new.kindFormHint",
    "registration.templateIsForm",
    "registration.issues.template_mode_mismatch",
    "registration.issues.no_person",
    "registration.issues.form_mode_needs_a_form",
    "registration.issues.form_mode_signature",
    "registration.issues.form_mode_placement",
    "registration.issues.form_mode_signer_role",
  ],
  register: [
    "intro.form",
    "success.formBody",
  ],
  verify: [
    "signedTitleForm",
    "signers.titleForm",
    "signers.noneForm",
    "check.matchTitleForm",
    "check.matchBodyForm",
    "check.differentTitleForm",
    "check.differentBodyForm",
    "check.fingerprintForm",
  ],
};

const LOCALES = ["en", "ms", "zh", "ko"] as const;

function load(locale: string): Tree | null {
  try {
    return (JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sign?: Tree }).Sign ?? null;
  } catch {
    return null;
  }
}

const sign = Object.fromEntries(LOCALES.map((l) => [l, load(l)])) as Record<(typeof LOCALES)[number], Tree | null>;

function at(root: Tree | null, area: string, path: string): unknown {
  let node: unknown = root?.[area];
  for (const part of path.split(".")) node = node && typeof node === "object" ? (node as Tree)[part] : undefined;
  return node;
}

const merged = typeof at(sign.en, "signerForm", "submitReview.title") === "string";
const run = merged ? describe : describe.skip;
const args = (s: string) => [...new Set([...s.matchAll(/\{(\w+)/g)].map((m) => m[1]))].sort();

run("the words of a form without a signature", () => {
  for (const [area, keys] of Object.entries(AREAS)) {
    it(`Sign.${area}: every key is there in all four languages with the same arguments`, () => {
      for (const key of keys) {
        const english = at(sign.en, area, key);
        expect(typeof english, `${area}.${key} in en`).toBe("string");
        for (const l of LOCALES.slice(1)) {
          const other = at(sign[l], area, key);
          expect(typeof other, `${area}.${key} in ${l}`).toBe("string");
          expect(args(other as string), `${area}.${key} arguments in ${l}`).toEqual(args(english as string));
          expect((other as string).trim().length, `${area}.${key} in ${l}`).toBeGreaterThan(0);
        }
      }
    });
  }

  it("is written in each language, not copied from English", () => {
    const sameAsEnglish: string[] = [];
    for (const [area, keys] of Object.entries(AREAS)) {
      for (const key of keys) {
        const english = at(sign.en, area, key) as string;
        for (const l of ["zh", "ko"] as const) if (at(sign[l], area, key) === english) sameAsEnglish.push(`${l}:${area}.${key}`);
      }
    }
    expect(sameAsEnglish).toEqual([]);
  });
});
