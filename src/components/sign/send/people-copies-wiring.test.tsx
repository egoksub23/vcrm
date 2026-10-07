import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

// How the pieces are wired, without a browser: the name box (the contact search) is replaced by a stand-in that remembers what it was given, so a
// test can "choose a contact" and see what the row asks its parent to change; the signing row and the copy row are replaced the same way inside
// PeopleStep, so a test can "choose the other type" and see what the screen hands to its parent.

const nameBoxes: { value: string; onChange: (v: string) => void; onPickContact: (c: unknown) => void; readOnly?: boolean }[] = [];
type RowProps = Record<string, unknown>;
const signerRows: RowProps[] = [];
const copyRows: RowProps[] = [];

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("./person-name-input", () => ({
  PersonNameInput: (props: { value: string; onChange: (v: string) => void; onPickContact: (c: unknown) => void; readOnly?: boolean }) => {
    nameBoxes.push(props);
    return <input data-name-box value={props.value} readOnly />;
  },
}));

import { emptyCopy, type CopyRow } from "@/lib/sign/client/copy-form";
import { emptyRow, type SignerRow } from "@/lib/sign/client/signers-form";
import type { SignRole } from "@/lib/sign/types";
import { CopyRowEditor } from "./copy-row";
import { SignerRowEditor } from "./signer-row";

function wording(): Record<string, unknown> {
  return (JSON.parse(readFileSync(join(process.cwd(), "messages", "en.json"), "utf8")) as { Sign: Record<string, unknown> }).Sign;
}
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{ Sign: wording() }}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
];
const mei = { id: "c1", name: " Mei Lin ", email: "mei@example.com", phone: "+60 12 345 6789", company: null };
const noEmail = { id: "c2", name: "Raj Kumar", email: null, phone: null, company: null };

const handlers = { onChange: vi.fn(), onRemove: vi.fn(), onMove: vi.fn(), onStep: vi.fn(), onDragStart: vi.fn(), onDragOver: vi.fn(), onDrop: vi.fn(), onDragEnd: vi.fn() };
const signerRow = (over: Partial<SignerRow> = {}): SignerRow => ({ ...emptyRow("merchant", 1), fullName: "Me", email: "", ...over });

beforeEach(() => {
  nameBoxes.length = 0;
  signerRows.length = 0;
  copyRows.length = 0;
});

describe.skipIf(!existsSync(join(process.cwd(), "messages", "en.json")) || !(wording() as { send?: { copies?: unknown } }).send?.copies)("choosing a contact for a person", () => {
  const renderSigner = (r: SignerRow) =>
    render(
      <ul>
        <SignerRowEditor row={r} index={0} count={1} roles={roles} ordered={false} showInvalid={false} whatsappConfigured notice={null} dragging={false} dropTarget={false} onReceiveCopy={() => {}} {...handlers} />
      </ul>,
    );
  const renderCopy = (r: CopyRow, onChange = vi.fn()) =>
    render(
      <ul>
        <CopyRowEditor row={r} index={0} showInvalid={false} canSign onChange={onChange} onRemove={() => {}} onMustSign={() => {}} />
      </ul>,
    );

  it("a signing row takes the contact's name and email, and keeps the email editable", () => {
    const onChange = vi.fn();
    render(
      <ul>
        <SignerRowEditor row={signerRow()} index={0} count={1} roles={roles} ordered={false} showInvalid={false} whatsappConfigured notice={null} dragging={false} dropTarget={false} {...handlers} onChange={onChange} />
      </ul>,
    );
    nameBoxes[0].onPickContact(mei);
    expect(onChange).toHaveBeenCalledWith({ fullName: "Mei Lin", email: "mei@example.com" });
    nameBoxes[0].onChange("Mei L");
    expect(onChange).toHaveBeenLastCalledWith({ fullName: "Mei L" });
    // the email box is an ordinary, editable one
    expect(renderSigner(signerRow({ email: "mei@example.com" }))).toMatch(/<input[^>]*type="email"[^>]*value="mei@example.com"(?![^>]*readonly)/);
  });

  it("a contact with no email leaves the typed email alone", () => {
    const onChange = vi.fn();
    render(
      <ul>
        <SignerRowEditor row={signerRow({ email: "typed@example.com" })} index={0} count={1} roles={roles} ordered={false} showInvalid={false} whatsappConfigured notice={null} dragging={false} dropTarget={false} {...handlers} onChange={onChange} />
      </ul>,
    );
    nameBoxes[0].onPickContact(noEmail);
    expect(onChange).toHaveBeenCalledWith({ fullName: "Raj Kumar", email: "typed@example.com" });
  });

  it("a WhatsApp row also takes the contact's phone when it has none yet", () => {
    const onChange = vi.fn();
    render(
      <ul>
        <SignerRowEditor row={signerRow({ channel: "whatsapp" })} index={0} count={1} roles={roles} ordered={false} showInvalid={false} whatsappConfigured notice={null} dragging={false} dropTarget={false} {...handlers} onChange={onChange} />
      </ul>,
    );
    nameBoxes[0].onPickContact(mei);
    expect(onChange).toHaveBeenCalledWith({ fullName: "Mei Lin", email: "mei@example.com", phone: "+60 12 345 6789" });
  });

  it("a Halo user's name box stays read-only", () => {
    render(
      <ul>
        <SignerRowEditor row={signerRow({ internalUserId: "u1" })} index={0} count={1} roles={roles} ordered={false} showInvalid={false} whatsappConfigured notice={null} dragging={false} dropTarget={false} {...handlers} />
      </ul>,
    );
    expect(nameBoxes[0].readOnly).toBe(true);
  });

  it("a copy row takes the contact's name and email, and the email stays editable", () => {
    const onChange = vi.fn();
    const html = renderCopy(emptyCopy({ fullName: "Me" }), onChange);
    nameBoxes[0].onPickContact(mei);
    expect(onChange).toHaveBeenCalledWith({ fullName: "Mei Lin", email: "mei@example.com" });
    expect(html).toMatch(/<input[^>]*type="email"/);
    expect(html).not.toMatch(/<input[^>]*type="email"[^>]*readonly/);
  });

  it("a copy row with a contact that has no email keeps what was typed", () => {
    const onChange = vi.fn();
    renderCopy(emptyCopy({ fullName: "Ra", email: "typed@example.com" }), onChange);
    nameBoxes[0].onPickContact(noEmail);
    expect(onChange).toHaveBeenCalledWith({ fullName: "Raj Kumar", email: "typed@example.com" });
  });
});

describe("the type switch on the People step", () => {
  // PeopleStep with the two row components replaced, so what each is handed can be called
  it("hands each signing row a way to receive a copy and each copy row a way to sign, moving the person between the lists", async () => {
    vi.resetModules();
    vi.doMock("./signer-row", () => ({ SignerRowEditor: (p: RowProps) => (signerRows.push(p), <li data-signer-stub />) }));
    vi.doMock("./copy-row", () => ({ CopyRowEditor: (p: RowProps) => (copyRows.push(p), <li data-copy-stub />) }));
    const { PeopleStep } = await import("./people-step");

    const rows = [signerRow({ fullName: "Ali", email: "ali@example.com" }), signerRow({ fullName: "Siti", email: "siti@example.com", roleKey: "director" })];
    const copies = [emptyCopy({ fullName: "Mei", email: "mei@example.com" })];
    const onRows = vi.fn();
    const onCopies = vi.fn();
    const base = { roles, showInvalid: false, whatsappConfigured: true, readOnly: false, signInOrder: false, onSignInOrder: () => {}, onGoToFields: () => {} };
    renderToStaticMarkup(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ Sign: wording() }} onError={() => {}}>
        <PeopleStep {...base} rows={rows} copies={copies} onRows={onRows} onCopies={onCopies} />
      </NextIntlClientProvider>,
    );
    expect(signerRows).toHaveLength(2);
    expect(copyRows).toHaveLength(1);

    // a signer chooses "Receives a copy": gone from the signing list, on the copy list with name and email
    (signerRows[1].onReceiveCopy as () => void)();
    expect(onRows.mock.calls[0][0].map((r: SignerRow) => r.fullName)).toEqual(["Ali"]);
    expect(onCopies.mock.calls[0][0].map((c: CopyRow) => [c.fullName, c.email])).toEqual([
      ["Mei", "mei@example.com"],
      ["Siti", "siti@example.com"],
    ]);

    // a copy person chooses "Must sign": on the signing list, gone from the copy list
    onRows.mockClear();
    onCopies.mockClear();
    (copyRows[0].onMustSign as () => void)();
    expect(onRows.mock.calls[0][0].map((r: SignerRow) => [r.fullName, r.email])).toEqual([
      ["Ali", "ali@example.com"],
      ["Siti", "siti@example.com"],
      ["Mei", "mei@example.com"],
    ]);
    expect(onCopies.mock.calls[0][0]).toEqual([]);

    // the add button and the row's edits and removal go to the copy list only
    onRows.mockClear();
    onCopies.mockClear();
    (copyRows[0].onChange as (p: unknown) => void)({ email: "mei2@example.com" });
    expect(onCopies.mock.calls[0][0][0]).toMatchObject({ fullName: "Mei", email: "mei2@example.com" });
    (copyRows[0].onRemove as () => void)();
    expect(onCopies.mock.calls[1][0]).toEqual([]);
    expect(onRows).not.toHaveBeenCalled();

    vi.doUnmock("./signer-row");
    vi.doUnmock("./copy-row");
  });
});
