import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// The sending workflow in every language with the real wording (next-intl throws on a missing key or argument): the stepper, the summary, the
// first screen (the documents), each step for a document on its own AND for a collection, the footer, and the whole screen of a draft. The
// pickers and the name box read the workspace's contacts, tickets and deals; here they only show what they were given.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "acc-1" }) }));
vi.mock("@/hooks/use-account-members", () => ({ useAccountMembers: () => ({ members: [], nameOf: () => "", profileOf: () => undefined }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("@/hooks/use-sign-templates", () => ({
  useActiveTemplates: () => ({
    loading: false,
    error: false,
    templates: [
      { id: "t1", name: "Merchant Agreement", description: null, category_id: null, pages: 3, roles: 2, mode: "sign" },
      { id: "t2", name: "Fee Schedule", description: "Rates", category_id: null, pages: 1, roles: 1, mode: "sign" },
    ],
  }),
}));
vi.mock("../send/person-name-input", () => ({ PersonNameInput: (p: { id?: string; value: string }) => <input data-name-box id={p.id} role="combobox" aria-controls="x" aria-expanded={false} defaultValue={p.value} /> }));
vi.mock("../send/contact-picker", () => ({ ContactPicker: (p: { contactId: string | null }) => <span data-picker="contact" data-value={p.contactId ?? ""} /> }));
vi.mock("../send/record-picker", () => ({ RecordPicker: (p: { kind: string; value: string | null }) => <span data-picker={p.kind} data-value={p.value ?? ""} /> }));

import { startingStep, type ProcessSource, type StepId } from "@/lib/sign/client/process";
import { liteDocs, processStatus, reachableSteps, summarize } from "@/lib/sign/client/process";
import type { EnvelopePerson } from "@/lib/sign/envelopes";
import { BlocksStep } from "./blocks-step";
import { NewProcess } from "./new-process";
import { ProcessPeople } from "./people-step";
import { ProcessFooter } from "./process-layout";
import { ProcessShell } from "./process-shell";
import { ProcessStepper } from "./process-stepper";
import { ProcessSummary } from "./process-summary";
import { SendStep } from "./send-step";
import { DocumentsStep } from "./documents-step";
import { baseOptions, fakeProcess, person, processDoc, role } from "./test-support";
import type { ProcessApi } from "./use-process";

type Tree = Record<string, unknown>;
const LOCALES = ["en", "ms", "zh", "ko"] as const;
const wording = (locale: string): Tree => (JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sign: Tree }).Sign;

function page(locale: string, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ Sign: wording(locale) }}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const WORDS: Record<(typeof LOCALES)[number], { documents: string; people: string; blocks: string; send: string; compact2: string; continueToPeople: string; mustSign: string; copy: string; leftHeading: string }> = {
  en: { documents: "Documents", people: "People", blocks: "Signature blocks", send: "Review and send", compact2: "Step 2 of 4: People", continueToPeople: "Continue to People", mustSign: "Must sign", copy: "Receives a copy", leftHeading: "What is left" },
  ms: { documents: "Dokumen", people: "Orang", blocks: "Blok tandatangan", send: "Semak dan hantar", compact2: "Langkah 2 daripada 4: Orang", continueToPeople: "Teruskan ke Orang", mustSign: "Mesti menandatangani", copy: "Menerima salinan", leftHeading: "Apa yang tinggal" },
  zh: { documents: "文件", people: "人员", blocks: "签名块", send: "检查并发送", compact2: "第 2 步，共 4 步：人员", continueToPeople: "继续到人员", mustSign: "必须签署", copy: "接收副本", leftHeading: "还剩什么" },
  ko: { documents: "문서", people: "사람", blocks: "서명 블록", send: "검토 및 발송", compact2: "4단계 중 2단계: 사람", continueToPeople: "사람(으)로 계속", mustSign: "서명 필요", copy: "사본 수신", leftHeading: "남은 일" },
};

const ALI = "pp_aliaaaa1";
const BALA = "pp_balabbbb2";
const ali = (over: Partial<EnvelopePerson> = {}) => person(ALI, "Ali", over);
const bala = (over: Partial<EnvelopePerson> = {}) => person(BALA, "Bala", { step: 2, ...over });
const cara = () => person("pp_cara0001", "Cara", { type: "copy" });

/** An uploaded file whose roles the people made, with the signature blocks given per person key. */
const upload = (n: number, who: EnvelopePerson[], blocks: Record<string, number> = {}) => {
  const signers = who.filter((p) => (p.type ?? "signer") === "signer");
  return processDoc(n, {
    roles: signers.map((p, i) => ({ ...role(p.key, p.fullName, i), source: "people" as const })),
    signatureCounts: Object.fromEntries(signers.map((p) => [p.key, blocks[p.key] ?? 0])),
    fieldCounts: Object.fromEntries(signers.map((p) => [p.key, blocks[p.key] ?? 0])),
    rolesNeeded: signers.filter((p) => (blocks[p.key] ?? 0) > 0).map((p) => p.key),
  });
};

const who = [ali(), bala(), cara()];

/** Is the button that holds `marker` disabled (the attribute, not the `disabled:` classes). */
function disabled(html: string, marker: string): boolean {
  const at = html.indexOf(marker);
  expect(at, `${marker} on the page`).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<button", at);
  return /\sdisabled(=|>|\s)/.test(html.slice(open, html.indexOf(">", at) + 1));
}
const OPEN = Object.fromEntries((["documents", "people", "blocks", "send"] as StepId[]).map((s) => [s, { open: true, blockedBy: null }])) as Record<StepId, { open: boolean; blockedBy: StepId | null }>;

describe("the stepper", () => {
  for (const locale of LOCALES) {
    const w = WORDS[locale];
    it(`names the four steps in order, marks the current one and the finished ones, and explains a step that is not open (${locale})`, () => {
      const docs = [upload(1, who)];
      const status = processStatus({ kind: "single", docs, people: who, ordered: false, optionIssues: [] });
      const html = page(locale, <ProcessStepper current="blocks" status={status} access={reachableSteps(status)} onGo={() => {}} />);
      for (const name of [w.documents, w.people, w.blocks, w.send]) expect(html).toContain(name);
      // in the row of steps (the phone's list comes before it)
      const row = html.slice(html.indexOf("<ol"));
      expect(row.indexOf(w.documents)).toBeLessThan(row.indexOf(w.people));
      expect(row.indexOf(w.people)).toBeLessThan(row.indexOf(w.blocks));
      expect(row.indexOf(w.blocks)).toBeLessThan(row.indexOf(w.send));
      // one current step, announced to a screen reader
      expect(html.match(/aria-current="step"/g)).toHaveLength(1);
      expect(html).toMatch(/data-step="blocks"[^>]*aria-current="step"|aria-current="step"[^>]*data-step="blocks"/);
      // documents and people are complete (a tick), the last step cannot be opened yet and says which one to finish
      expect(html).toMatch(/data-step="documents"[^>]*data-state="done"|data-state="done"[^>]*data-step="documents"/);
      expect(html).toMatch(/data-step="people"[^>]*data-state="done"|data-state="done"[^>]*data-step="people"/);
      expect(html).toMatch(/data-step="send"[^>]*data-state="locked"|data-state="locked"[^>]*data-step="send"/);
      expect(html).toContain('aria-disabled="true"');
    });

    it(`becomes "Step 2 of 4: ..." with a list on a phone (${locale})`, () => {
      const html = page(locale, <ProcessStepper current="people" status={null} access={OPEN} onGo={() => {}} />);
      expect(html).toContain(w.compact2);
      expect(html).toContain("<select");
      expect(html.match(/<option/g)).toHaveLength(4);
    });
  }

  it("calls the third step the form for a form without a signature", () => {
    const html = page("en", <ProcessStepper current="people" status={null} access={OPEN} onGo={() => {}} formOnly />);
    expect(html).toContain(">Form<");
    expect(html).not.toContain("Signature blocks");
  });
});

describe("the summary", () => {
  const docs = [upload(1, who, { [ALI]: 2 }), upload(2, who, { [ALI]: 1, [BALA]: 1 })];
  const facts = { kind: "collection" as const, docs, people: who, ordered: false, optionIssues: [] };
  for (const locale of LOCALES) {
    const w = WORDS[locale];
    it(`shows the documents, the people with their type and blocks, and what is left (${locale})`, () => {
      const html = page(locale, <ProcessSummary summary={summarize(facts, "Onboarding")} kind="collection" onGo={() => {}} />);
      expect(html).toContain("Onboarding");
      expect(html).toContain("Document 1");
      expect(html).toContain("Document 2");
      expect(html).toContain("Ali");
      expect(html).toContain("Cara");
      expect(html).toContain(w.mustSign);
      expect(html).toContain(w.copy);
      expect(html).toContain(w.leftHeading);
      // a labelled landmark, in two forms (a card beside the steps, a collapsible one on a phone)
      expect(html).toContain("<aside");
      expect(html).toContain("<details");
      // every item is done, in both forms
      expect(html.match(/data-left="[a-z]+" data-done="true"/g)?.length).toBe(12);
      expect(html).not.toContain('data-done="false"');
    });
  }

  it("turns each item of what is left green as the sender goes, and an item not done is a button that goes there", () => {
    const stage = (people: EnvelopePerson[], docs: ReturnType<typeof upload>[]) =>
      page("en", <ProcessSummary summary={summarize({ kind: "collection", docs, people, ordered: false, optionIssues: [] }, "X")} kind="collection" onGo={() => {}} />);
    const start = stage([], [upload(1, []), upload(2, [])]);
    expect(start).toContain('data-left="documents" data-done="true"');
    expect(start).toContain('data-left="signer" data-done="false"');
    expect(start).toContain("Nobody has been added yet.");
    expect(start).toContain("Add at least one person who must sign");
    // the next stage: people added, no blocks yet
    const people = [ali(), bala()];
    const next = stage(people, [upload(1, people), upload(2, people)]);
    expect(next).toContain('data-left="signer" data-done="true"');
    expect(next).toContain('data-left="blocks" data-done="false"');
    expect(next).toContain("Place a signature block in 2 documents that have none");
    expect(next).toContain("0 signature blocks");
    const done = stage(people, [upload(1, people, { [ALI]: 1 }), upload(2, people, { [BALA]: 1 })]);
    expect(done).toContain("Everything is ready to send.");
  });
});

describe("the first screen: the documents", () => {
  const ID = { contact: "11111111-1111-4111-8111-111111111111", ticket: "22222222-2222-4222-8222-222222222222", deal: "33333333-3333-4333-8333-333333333333" };
  for (const locale of LOCALES) {
    const w = WORDS[locale];
    it(`is step 1: one drop zone for any number of files, the templates, a title, the four steps, and no contact (${locale})`, () => {
      const html = page(locale, <NewProcess contactId={ID.contact} ticketId={ID.ticket} dealId={ID.deal} />);
      for (const name of [w.documents, w.people, w.blocks, w.send]) expect(html).toContain(name);
      expect(html).toMatch(/<input[^>]*type="file"[^>]*multiple|<input[^>]*multiple[^>]*type="file"/);
      expect(html).toContain(".pdf,.docx,.doc,.png,.jpg,.jpeg");
      expect(html).toContain("Merchant Agreement");
      expect(html).toContain('id="new-title"');
      // no contact, ticket or deal is asked for here (an address that names one keeps it, and the draft is made attached to it)
      expect(html).not.toContain("data-picker");
      expect(html).not.toContain("new-contact");
      // nothing is chosen yet: Continue says where it goes and cannot be used
      expect(html).toContain(w.continueToPeople);
      const at = html.indexOf(w.continueToPeople);
      const open = html.lastIndexOf("<button", at);
      expect(html.slice(open, html.indexOf(">", open) + 1)).toMatch(/\sdisabled(=|>|\s)/);
    });
  }

  it("says collection, not envelope, and has no single/collection choice any more", () => {
    for (const locale of ["en", "ms"] as const) {
      const html = page(locale, <NewProcess />);
      expect(html.toLowerCase()).not.toContain("envelope");
      expect(html.toLowerCase()).not.toContain("sampul");
      expect(html).not.toContain('name="kind"');
    }
  });
});

describe("the People step", () => {
  const props = { ordered: false, readOnly: false, showInvalid: false, whatsappConfigured: true as boolean | null, onPeople: () => {}, onOrdered: () => {} };
  for (const locale of LOCALES) {
    const w = WORDS[locale];
    for (const kind of ["single", "collection"] as const) {
      it(`is one list of everyone, each a name, an email and a type, with nothing about roles per document or fields (${kind}, ${locale})`, () => {
        const docs = kind === "single" ? [upload(1, who)] : [upload(1, who), upload(2, who)];
        const html = page(locale, <ProcessPeople kind={kind} docs={liteDocs(docs)} workDocs={docs} people={who} {...props} />);
        expect(html.match(/data-person-type="signer"/g)).toHaveLength(2);
        expect(html.match(/data-person-type="copy"/g)).toHaveLength(1);
        expect(html).toContain(w.mustSign);
        expect(html).toContain(w.copy);
        expect(html.match(/data-name-box/g)).toHaveLength(3);
        expect(html.match(/type="email"/g)).toHaveLength(3);
        // roles are made from the people: nothing to match for an uploaded file
        expect(html).not.toContain("env-template-roles");
        expect(html).not.toContain("Match the template");
      });
    }
  }

  it("matches the roles of a document that came from a template, and only those", () => {
    const tpl = processDoc(1, { fromTemplate: true, roles: [role("merchant", "Merchant"), role("director", "Director", 1)], rolesNeeded: ["merchant", "director"] });
    const html = page("en", <ProcessPeople kind="single" docs={liteDocs([tpl])} workDocs={[tpl]} people={[ali({ roles: { [tpl.id]: "merchant" } })]} {...props} />);
    expect(html).toContain("Match the template");
    expect(html).toContain("Merchant");
    expect(html).toContain("Director");
  });

  it("says what a single document's limits are in words of the process, not of a collection", () => {
    const many = Array.from({ length: 6 }, (_, i) => person(`pp_s${i}aaaaaa`, `S${i}`));
    const html = page("en", <ProcessPeople kind="single" docs={liteDocs([upload(1, many)])} workDocs={[upload(1, many)]} people={many} {...props} />);
    expect(html).toContain("Up to 6 people can be asked to sign an uploaded file");
    expect(html).not.toContain("A collection");
  });
});

describe("the Signature blocks step", () => {
  const docs = [upload(1, who, { [ALI]: 3 }), upload(2, who), processDoc(3, { mode: "form", hasForm: true, fromTemplate: true })];
  for (const locale of LOCALES) {
    it(`is a card for each document of a collection with its title, pages, status and who has something to sign (${locale})`, () => {
      const html = page(locale, <BlocksStep process={fakeProcess({ kind: "collection", docs, people: who, step: "blocks" })} />);
      for (const d of docs) expect(html).toContain(d.title);
      expect(html.match(/data-doc-card=/g)).toHaveLength(3);
      expect(html).toContain('data-doc-card="00000001-0000-4000-8000-000000000000" data-state="partial"');
      expect(html).toContain('data-doc-card="00000002-0000-4000-8000-000000000000" data-state="empty"');
      // who has a block and who has nothing here
      expect(html).toContain('data-covered="true"');
      expect(html).toContain('data-covered="false"');
      // the people who must sign, in a strip, with their blocks
      expect(html).toContain("data-people-strip");
      expect(html.match(/data-person="/g)).toHaveLength(2);
      // a button to open each document's editor
      expect(html.match(/<button/g)?.length).toBeGreaterThanOrEqual(3);
    });
  }

  it("says in words how many blocks are placed and for whom, and what is missing", () => {
    const html = page("en", <BlocksStep process={fakeProcess({ kind: "collection", docs, people: who, step: "blocks" })} />);
    expect(html).toContain("3 blocks placed · assigned to Ali");
    expect(html).toContain("No signature block yet");
    expect(html).toContain("Bala");
    expect(html).toContain("has nothing to sign here");
    expect(html).toContain("Open editor");
    expect(html).toContain(">Edit<");
    expect(html).toContain("Form");
    expect(html).toContain("no block yet");
  });

  it("shows the editor for a document on its own, under the strip of the people who must sign", () => {
    const html = page("en", <BlocksStep process={fakeProcess({ kind: "single", docs: [upload(1, who, { [ALI]: 1 })], people: who, step: "blocks" })} />);
    expect(html).toContain("data-people-strip");
    expect(html).toContain("Loading the editor");
    expect(html).not.toContain("data-doc-card");
    expect(html).not.toContain("Back to the documents");
  });

  it("opens a collection's document with the way back and the way on", () => {
    const open = (openDocId: string | null) => page("en", <BlocksStep process={fakeProcess({ kind: "collection", docs, people: who, step: "blocks", over: { openDocId } })} />);
    const first = open(docs[0].id);
    expect(first).toContain("Back to the documents");
    expect(first).toContain("Save and next document");
    expect(first).toContain("Document 1 of 3: Document 1");
    expect(open(docs[2].id)).toContain("Save and back to the documents");
  });
});

describe("the Review and send step", () => {
  const ready = (kind: "single" | "collection") => {
    const d = kind === "single" ? [upload(1, who, { [ALI]: 1, [BALA]: 1 })] : [upload(1, who, { [ALI]: 1 }), upload(2, who, { [BALA]: 1 })];
    return fakeProcess({ kind, docs: d, people: who, options: { signInOrder: true, codeRequired: true, message: "Please sign" } });
  };
  const render = (locale: string, p: ReturnType<typeof ready>, headroom: null | { limit: number; used: number; remaining: number; needed: number; fits: boolean } = null) =>
    page(locale, <SendStep process={p} categories={[]} defaultExpiryDays={14} now={Date.parse("2026-10-06T08:00:00Z")} headroom={headroom} onOpen={() => {}} />);

  for (const locale of LOCALES) {
    for (const kind of ["single", "collection"] as const) {
      it(`summarises who signs what and who gets a copy, holds the options and the links, and can send when nothing is left (${kind}, ${locale})`, () => {
        const html = render(locale, ready(kind));
        expect(html).toContain("Ali");
        expect(html).toContain("Bala");
        expect(html).toContain("Cara");
        expect(html).toContain("data-copy-review");
        expect(html).toContain("Please sign");
        // the options, without the title and the contact (step 1 and the links own those)
        expect(html).toContain('id="opt-locale"');
        expect(html).toContain('id="opt-expiry"');
        expect(html).toContain('id="opt-reminders"');
        expect(html).not.toContain('id="opt-title"');
        expect(html).not.toContain('id="opt-contact"');
        // the links: contact (with its change or remove control), ticket and deal
        expect(html).toContain('id="process-links"');
        expect(html).toContain('data-picker="contact"');
        expect(html).toContain('data-picker="ticket"');
        expect(html).toContain('data-picker="deal"');
        expect(html).not.toContain("data-problems");
        expect(disabled(html, "data-send")).toBe(false);
      });
    }
  }

  it("only a document on its own offers forwarding and a category; a collection does not", () => {
    expect(render("en", ready("single"))).toContain("Forwarding");
    expect(render("en", ready("collection"))).not.toContain("Forwarding");
  });

  it("lists what is left in plain words, each with a button to the right step or document, and cannot send", () => {
    const d = [upload(1, who, { [ALI]: 1 }), upload(2, who)];
    const html = render("en", fakeProcess({ kind: "collection", docs: d, people: who, serverProblems: [{ code: "document_nobody", document: d[1].id }], options: { expiryDate: "2026-10-01" } }));
    expect(html).toContain("data-problems");
    expect(html).toContain('data-problem="document_nobody"');
    expect(html).toContain('data-problem="expiry_past"');
    expect(html).toContain("Open the document");
    expect(html).toContain("Go to the options");
    expect(html).toContain("Fix the things listed above to send.");
    expect(disabled(html, "data-send")).toBe(true);
    // each problem names its document in a collection
    expect(html).toContain("Document 2");
  });

  it("names the step a problem of the people is put right in", () => {
    const html = render("en", fakeProcess({ kind: "single", docs: [upload(1, [ali()], { [ALI]: 1 })], people: [ali(), bala({ email: ali().email })] }));
    expect(html).toContain('data-problem="duplicate_person"');
    expect(html).toContain("Go to People");
  });

  it("is blocked, with the reason, for someone who may not send, and when the month has no room for a collection", () => {
    expect(page("en", <SendStep process={fakeProcess({ kind: "single", docs: [upload(1, who, { [ALI]: 1, [BALA]: 1 })], people: who, over: { canSend: false } })} categories={[]} defaultExpiryDays={14} now={0} headroom={null} onOpen={() => {}} />)).toContain("You do not have permission to send documents.");
    const full = render("en", ready("collection"), { limit: 10, used: 9, remaining: 1, needed: 2, fits: false });
    expect(full).toContain("room for 2 documents");
    expect(disabled(full, "data-send")).toBe(true);
  });
});

describe("the Documents step of a draft", () => {
  const docs = [upload(1, who, { [ALI]: 1 }), upload(2, who, { [BALA]: 1 })];
  for (const locale of LOCALES) {
    it(`keeps the title and the files editable once the drafts exist (${locale})`, () => {
      const single = page(locale, <DocumentsStep process={fakeProcess({ kind: "single", docs: [docs[0]], people: who, step: "documents" })} envelopeId={null} />);
      expect(single).toContain('id="process-title"');
      expect(single).toContain("Document 1");
      expect(single.match(/lucide-file-up/g)).toHaveLength(1);
      const collection = page(locale, <DocumentsStep process={fakeProcess({ kind: "collection", docs, people: who, step: "documents" })} envelopeId="e1" />);
      expect(collection).toContain('id="process-title"');
      expect(collection.match(/draggable="true"/g)).toHaveLength(2);
      expect(collection.match(/lucide-file-up/g)).toHaveLength(2);
      // each document's blocks are placed in step 3, so no link to the document's own page
      expect(collection).not.toContain('href="/sign/00000001');
    });
  }
});

describe("the footer", () => {
  for (const locale of LOCALES) {
    it(`names the next step on Continue and says why it cannot be used yet (${locale})`, () => {
      const w = WORDS[locale];
      const ok = page(locale, <ProcessFooter step="documents" nextName={w.people} onBack={() => {}} onContinue={() => {}} />);
      expect(ok).toContain(w.continueToPeople);
      expect(ok).not.toContain("process-continue-why");
      const why = page(locale, <ProcessFooter step="people" nextName={w.blocks} blockedText="Add at least one person." onBack={() => {}} onContinue={() => {}} />);
      expect(why).toContain("Add at least one person.");
      expect(why).toContain('aria-describedby="process-continue-why"');
    });
  }

  it("has no Continue on the last step, and no Back on the first", () => {
    const last = page("en", <ProcessFooter step="send" nextName={null} onBack={() => {}} onContinue={() => {}} />);
    expect(last).not.toContain("Continue");
    const first = page("en", <ProcessFooter step="documents" nextName="People" onBack={() => {}} onContinue={() => {}} />);
    const back = first.slice(first.indexOf("<button"), first.indexOf(">", first.indexOf("<button")) + 1);
    expect(back).toMatch(/\sdisabled(=|>|\s)/);
  });
});

describe("the whole screen of a draft", () => {
  const api: ProcessApi = { savePeople: async () => {}, saveOptions: async () => null, send: async () => ({ reference: null, expiresAt: "", invited: [], documents: 1 }), remove: async () => {}, reload: async () => null };
  const sourceOf = (kind: "single" | "collection", people: EnvelopePerson[], blocks: Record<string, number>): ProcessSource => {
    const docs = kind === "single" ? [upload(1, people, blocks)] : [upload(1, people, blocks), upload(2, people, blocks)];
    const signers = people
      .filter((p) => (p.type ?? "signer") === "signer" && p.email)
      .map((p, i) => ({ id: `s${i}`, account_id: "a", document_id: docs[0].id, role_key: p.key, kind: "signer", full_name: p.fullName, email: p.email, phone: null, channel: "email", order_no: i + 1, party_id: `s${i}`, part_keys: null }) as never);
    return { kind, id: kind === "single" ? docs[0].id : "e1", reference: "SGN-2026-000001", docs, signers, copies: [], options: { ...baseOptions, title: "Merchant Agreement" }, serverProblems: [], headroom: null };
  };
  const shell = (locale: string, src: ProcessSource, asked?: { step?: string }) => page(locale, <ProcessShell source={src} api={api} asked={asked} onOpen={() => {}} />);

  for (const locale of LOCALES) {
    const w = WORDS[locale];
    for (const kind of ["single", "collection"] as const) {
      it(`lands on the first step that is not complete, with the stepper, the summary and the footer (${kind}, ${locale})`, () => {
        // the documents are there and nobody was added yet: People
        const html = shell(locale, sourceOf(kind, [], {}));
        expect(html).toContain('data-step-body="people"');
        expect(html).toMatch(/aria-current="step"[^>]*data-step="people"|data-step="people"[^>]*aria-current="step"/);
        expect(html).toContain("data-process-summary");
        expect(html).toContain("data-process-footer");
        expect(html).toContain(w.documents);
        // Continue names the next step and says why it cannot be used yet
        expect(html).toContain(w.blocks);
        expect(html).toContain("process-continue-why");
        // the title is the draft's own, shown as the heading
        expect(html).toContain("Merchant Agreement");
      });
    }
  }

  it("lands on the signature blocks when the people are there, and on review when everything is", () => {
    const people = [ali(), bala()];
    expect(shell("en", sourceOf("collection", people, {}))).toContain('data-step-body="blocks"');
    expect(shell("en", sourceOf("single", people, { [ALI]: 1, [BALA]: 1 }))).toContain('data-step-body="send"');
    expect(shell("en", sourceOf("collection", people, { [ALI]: 1, [BALA]: 1 }))).toContain('data-step-body="send"');
  });

  it("opens the step asked for (?step=) when it can be opened, and the first incomplete one when it cannot", () => {
    const people = [ali(), bala()];
    expect(shell("en", sourceOf("single", people, {}), { step: "documents" })).toContain('data-step-body="documents"');
    expect(shell("en", sourceOf("single", people, {}), { step: "send" })).toContain('data-step-body="blocks"');
    expect(startingStep(processStatus({ kind: "single", docs: [upload(1, people)], people, ordered: false, optionIssues: [] }), "people")).toBe("people");
  });

  it("is the same screen for a collection and a document on its own, apart from what is the collection's", () => {
    const single = shell("en", sourceOf("single", [], {}));
    const collection = shell("en", sourceOf("collection", [], {}));
    for (const html of [single, collection]) {
      expect(html).toContain('aria-label="Steps to send this"');
      expect(html).toContain("Delete");
      expect(html).toContain("Add a person");
    }
    expect(collection).toContain("2 documents");
    expect(single).not.toContain("2 documents");
  });
});

// migration 176: the "Private" switch of step 1, for a document on its own and for a collection, on the first screen and on the Documents step
describe("the Private switch", () => {
  const PRIVATE_WORDS: Record<(typeof LOCALES)[number], { single: string; collection: string; hintSingle: string; hintCollection: string; notYours: string; badge: string }> = {
    en: { single: "Private document", collection: "Private document collection", hintSingle: "admins and the Halo users you name as signers can see this document", hintCollection: "can see this collection and every document in it", notYours: "Only the person who uploaded this, or an admin, can change this.", badge: "Private" },
    ms: { single: "Dokumen peribadi", collection: "Koleksi dokumen peribadi", hintSingle: "Hanya anda, admin ruang kerja dan pengguna Halo yang anda namakan sebagai penandatangan boleh melihat dokumen ini", hintCollection: "boleh melihat koleksi ini dan setiap dokumen di dalamnya", notYours: "Hanya orang yang memuat naik ini, atau admin, boleh menukarnya.", badge: "Peribadi" },
    zh: { single: "私密文档", collection: "私密文件集", hintSingle: "只有您、工作区管理员和您指定为签署人的 Halo 用户可以查看此文档", hintCollection: "可以查看此文件集及其中的每份文档", notYours: "只有上传者或管理员可以更改此项。", badge: "私密" },
    ko: { single: "비공개 문서", collection: "비공개 문서 모음", hintSingle: "본인, 워크스페이스 관리자, 서명자로 지정한 Halo 사용자만 이 문서와", hintCollection: "그 안의 모든 문서", notYours: "이 문서를 업로드한 사람이나 관리자만 변경할 수 있습니다.", badge: "비공개" },
  };
  const docs = [upload(1, who, { [ALI]: 1 }), upload(2, who, { [BALA]: 1 })];
  const switchOf = (html: string) => /<[^>]*role="switch"[^>]*>/.exec(html.slice(html.indexOf("data-private-toggle")))?.[0] ?? "";

  for (const locale of LOCALES) {
    const w = PRIVATE_WORDS[locale];

    it(`is on the first screen, off to begin with, and worded for what will be made (${locale})`, () => {
      const html = page(locale, <NewProcess />);
      expect(html).toContain("data-private-toggle");
      expect(html).toContain(w.single);
      expect(html).toContain(w.hintSingle);
      expect(switchOf(html)).toContain('aria-checked="false"');
      expect(html).not.toContain("private.toggle");
    });

    it(`is on the Documents step of a draft: private or not as saved, worded for a document on its own and for a collection (${locale})`, () => {
      const open = page(locale, <DocumentsStep process={fakeProcess({ kind: "single", docs: [docs[0]], people: who, step: "documents" })} envelopeId={null} />);
      expect(open).toContain(w.single);
      expect(open).toContain(w.hintSingle);
      expect(switchOf(open)).toContain('aria-checked="false"');
      expect(open).not.toContain(w.notYours);
      const secret = page(locale, <DocumentsStep process={fakeProcess({ kind: "collection", docs, people: who, step: "documents", options: { isPrivate: true } })} envelopeId="e1" />);
      expect(secret).toContain(w.collection);
      expect(secret).toContain(w.hintCollection);
      expect(switchOf(secret)).toContain('aria-checked="true"');
    });

    it(`says why it cannot be changed by someone who is neither the uploader nor an admin, and just is read only for someone who cannot send (${locale})`, () => {
      const notYours = page(locale, <DocumentsStep process={fakeProcess({ kind: "single", docs: [docs[0]], people: who, step: "documents", options: { isPrivate: true }, over: { canChangePrivacy: false } })} envelopeId={null} />);
      expect(notYours).toContain(w.notYours);
      expect(switchOf(notYours)).toMatch(/data-disabled|disabled/);
      const readOnly = page(locale, <DocumentsStep process={fakeProcess({ kind: "single", docs: [docs[0]], people: who, step: "documents", over: { canSend: false, canChangePrivacy: false } })} envelopeId={null} />);
      expect(readOnly).not.toContain(w.notYours);
      expect(switchOf(readOnly)).toMatch(/data-disabled|disabled/);
    });
  }

  it("never says envelope", () => {
    for (const locale of LOCALES) {
      const html = page(locale, <DocumentsStep process={fakeProcess({ kind: "collection", docs, people: who, step: "documents", options: { isPrivate: true } })} envelopeId="e1" />);
      expect(html.toLowerCase()).not.toContain("envelope");
    }
  });
});
