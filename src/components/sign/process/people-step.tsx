"use client";

// ============================================================
// Doc Sign, step 2 of the sending workflow: everyone who takes part, on ONE screen, for a document on its own and for a collection. Each person is
// a name (a matching contact fills the email, which stays editable), an email and a TYPE: "Must sign" or "Receives a copy". For a person who
// must sign: how the link is sent (email or WhatsApp), their step when people sign one after another, and (a document on its own) a Halo user
// of this workspace to sign from inside Halo. Nothing about roles per document and nothing about fields here: an uploaded file takes a role from
// each person who must sign (the sender then gives each signature block to a person in step 3), and only a document that came from a template
// has roles to match, in "Match the template's roles" under the list. A person who receives a copy needs no channel and no step: they get the
// signed copy by email when everything is signed.
// ============================================================

import { useState } from "react";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { addPerson, countByType, normalizePersonSteps, personHasInput, personIsComplete, removePerson, setPersonType, setTemplateMatch, templateMatches, updatePerson } from "@/lib/sign/client/envelope-form";
import { MAX_COPY_RECIPIENTS, isCopy, isSigner, isUploadDoc, roleCoverage, type EnvelopeDocLite, type EnvelopePerson } from "@/lib/sign/envelopes";
import { MAX_ROLES, MAX_SIGNERS, normalizePhone } from "@/lib/sign/rules";

import { HaloUserPicker } from "../send/halo-user-picker";
import { PersonNameInput } from "../send/person-name-input";
import { applyContact, removalAsk, type RemovalAsk } from "../envelope/people-edit";
import type { ProcessKind } from "@/lib/sign/client/process";

interface Props {
  kind: ProcessKind;
  /** A form without a signature: nobody signs, the people fill it in. */
  formOnly?: boolean;
  docs: readonly EnvelopeDocLite[];
  /** What the documents have assigned to each role, so removing a person can say what goes with them (the documents as the server sent them). */
  workDocs?: readonly { id: string; fromTemplate?: boolean; fieldCounts?: Record<string, number> }[];
  people: readonly EnvelopePerson[];
  ordered: boolean;
  readOnly: boolean;
  /** Show what is wrong with a person even before they have typed anything (after the review was asked for). */
  showInvalid: boolean;
  /** Whether a WhatsApp template is set up (null: not known yet). */
  whatsappConfigured: boolean | null;
  onPeople: (people: EnvelopePerson[]) => void;
  onOrdered: (ordered: boolean) => void;
}

const SELECT = "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The words of the question asked before a person with fields assigned to them is removed (one component, so the wording is tested as shown). */
export function RemovalWords({ ask, part }: { ask: RemovalAsk; part: "title" | "body" }) {
  const t = useTranslations("Sign.send.envelope.people.removeDialog");
  return <>{part === "title" ? t("title", { name: ask.name }) : t("body", { fields: ask.fields, documents: ask.documents })}</>;
}

export function ProcessPeople({ kind, formOnly = false, docs, workDocs = [], people, ordered, readOnly, showInvalid, whatsappConfigured, onPeople, onOrdered }: Props) {
  const t = useTranslations("Sign.send.envelope.people");
  const tp = useTranslations("Sign.process.people");
  const th = useTranslations("Sign.send.people");
  const [asking, setAsking] = useState<RemovalAsk | null>(null);
  /** The person a Halo user is being chosen for (a document on its own only). */
  const [haloFor, setHaloFor] = useState<string | null>(null);
  const allowHalo = kind === "single" && !formOnly;
  const change = (next: EnvelopePerson[]) => onPeople(ordered ? normalizePersonSteps(next) : next);

  const counts = countByType(people);
  const hasUpload = docs.some(isUploadDoc);
  const signerLimit = hasUpload ? MAX_ROLES : MAX_SIGNERS;
  const signersFull = counts.signers >= signerLimit;
  const copiesFull = counts.copies >= MAX_COPY_RECIPIENTS;
  const nameOf = (p: EnvelopePerson, i: number) => p.fullName.trim() || t("personN", { n: i + 1 });

  // the roles of the documents that came from a template are matched to people here; an uploaded file's roles are the people themselves
  const templateDocs = docs.filter((d) => !isUploadDoc(d));
  const coverage = roleCoverage(templateDocs, people).filter((c) => c.people > 1 || (c.people === 0 && c.needed));
  const matches = templateMatches(docs, people);
  const matchedDocuments = [...new Set(matches.map((m) => m.documentId))];
  const titleOf = (id: string) => docs.find((d) => d.id === id)?.title ?? "";
  const labelOf = (id: string, key: string) => docs.find((d) => d.id === id)?.roles.find((r) => r.key === key)?.label ?? key;
  const signers = people.filter(isSigner);

  const requestRemove = (p: EnvelopePerson, i: number) => {
    const ask = removalAsk(people, p.key, workDocs, nameOf(p, i));
    if (ask) setAsking(ask);
    else change(removePerson(people, p.key));
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{tp(formOnly ? "introForm" : "intro")}</p>

      <label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox className="mt-0.5" checked={ordered} disabled={readOnly} onCheckedChange={(c) => onOrdered(!!c)} />
        <span>
          <span className="block text-sm font-medium text-foreground">{t("ordered")}</span>
          <span className="block text-xs text-muted-foreground">{t("orderedHint")}</span>
        </span>
      </label>

      {people.length === 0 ? <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">{t("empty")}</p> : null}

      <ol className="space-y-3">
        {people.map((p, i) => {
          const copy = isCopy(p);
          const touched = showInvalid || personHasInput(p);
          const nameBad = touched && (!p.fullName.trim() || p.fullName.trim().length > 160);
          const emailBad = touched && !EMAIL_RE.test(p.email.trim());
          const phoneBad = touched && !copy && p.channel === "whatsapp" && normalizePhone(p.phone) === null;
          // a person who must sign needs a place on the documents: an uploaded file gives every person one, a template's role must be matched
          const rolesBad = touched && !copy && !personIsComplete({ ...p, fullName: "x", email: "x@x.xx", phone: "+60123456789", step: 1 }, docs);
          return (
            <li key={p.key} data-person-type={copy ? "copy" : "signer"} className="space-y-3 rounded-xl border border-border bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-foreground">{nameOf(p, i)}</p>
                <Button type="button" variant="ghost" size="sm" disabled={readOnly} aria-label={t("remove", { name: nameOf(p, i) })} onClick={() => requestRemove(p, i)}>
                  <Trash2 aria-hidden />
                  {t("removeShort")}
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label htmlFor={`${p.key}-name`} className="text-xs font-medium text-foreground">
                    {t("fullName")}
                  </label>
                  <PersonNameInput
                    id={`${p.key}-name`}
                    value={p.fullName}
                    disabled={readOnly}
                    readOnly={!!p.internalUserId}
                    invalid={nameBad}
                    onChange={(name) => change(updatePerson(people, p.key, { fullName: name }, docs))}
                    onPickContact={(c) => change(applyContact(people, p.key, c, docs))}
                  />
                  {nameBad ? <p className="text-xs text-destructive">{t("errors.name")}</p> : null}
                </div>
                <div className="space-y-1">
                  <label htmlFor={`${p.key}-email`} className="text-xs font-medium text-foreground">
                    {t("email")}
                  </label>
                  <Input id={`${p.key}-email`} type="email" value={p.email} maxLength={254} autoComplete="off" disabled={readOnly} readOnly={!!p.internalUserId} aria-invalid={emailBad} onChange={(e) => change(updatePerson(people, p.key, { email: e.target.value }))} />
                  {emailBad ? <p className="text-xs text-destructive">{t("errors.email")}</p> : null}
                </div>
                <div className="space-y-1">
                  <label htmlFor={`${p.key}-type`} className="text-xs font-medium text-foreground">
                    {t("type.label")}
                  </label>
                  <select id={`${p.key}-type`} className={SELECT} value={copy ? "copy" : "signer"} disabled={readOnly} onChange={(e) => change(setPersonType(people, p.key, e.target.value === "copy" ? "copy" : "signer", docs))}>
                    <option value="signer" disabled={copy && signersFull}>
                      {formOnly ? tp("typeFiller") : t("type.signer")}
                    </option>
                    <option value="copy" disabled={!copy && copiesFull}>
                      {t("type.copy")}
                    </option>
                  </select>
                </div>
                {!copy ? (
                  <div className="space-y-1">
                    <label htmlFor={`${p.key}-channel`} className="text-xs font-medium text-foreground">
                      {t("channel.label")}
                    </label>
                    <select id={`${p.key}-channel`} className={SELECT} value={p.channel} disabled={readOnly} onChange={(e) => change(updatePerson(people, p.key, { channel: e.target.value === "whatsapp" ? "whatsapp" : "email" }))}>
                      <option value="email">{t("channel.email")}</option>
                      <option value="whatsapp">{t("channel.whatsapp")}</option>
                    </select>
                    {p.channel === "whatsapp" && whatsappConfigured === false ? <p className="text-xs text-[light-dark(#92400e,#fcd34d)]">{t("whatsappOff")}</p> : null}
                  </div>
                ) : null}
                {!copy && p.channel === "whatsapp" ? (
                  <div className="space-y-1">
                    <label htmlFor={`${p.key}-phone`} className="text-xs font-medium text-foreground">
                      {t("phone")}
                    </label>
                    <Input id={`${p.key}-phone`} type="tel" value={p.phone} placeholder="+60123456789" disabled={readOnly} aria-invalid={phoneBad} onChange={(e) => change(updatePerson(people, p.key, { phone: e.target.value }))} />
                    {phoneBad ? <p className="text-xs text-destructive">{t("errors.phone")}</p> : null}
                  </div>
                ) : null}
                {!copy && ordered ? (
                  <div className="space-y-1">
                    <label htmlFor={`${p.key}-step`} className="text-xs font-medium text-foreground">
                      {t("step")}
                    </label>
                    <Input id={`${p.key}-step`} type="number" min={1} max={MAX_SIGNERS} value={p.step} disabled={readOnly} className="w-24" onChange={(e) => change(updatePerson(people, p.key, { step: Math.max(1, Math.min(MAX_SIGNERS, Math.floor(Number(e.target.value)) || 1)) }))} />
                    <p className="text-xs text-muted-foreground">{t("stepHint")}</p>
                  </div>
                ) : null}
              </div>
              {p.internalUserId ? (
                // a Halo user signs from inside Halo; the invitation still goes to their email, so the name and the email are theirs and are not typed
                <div className="flex flex-wrap items-center gap-2">
                  <span data-halo-user className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground">
                    <ShieldCheck className="size-3" aria-hidden />
                    {th("haloUserTag")}
                  </span>
                  <span className="text-xs text-muted-foreground">{th("haloUserNote")}</span>
                  <Button type="button" variant="ghost" size="xs" disabled={readOnly} onClick={() => change(updatePerson(people, p.key, { internalUserId: null }))}>
                    {th("haloUserRemove")}
                  </Button>
                </div>
              ) : allowHalo && !copy ? (
                <div>
                  <Button type="button" variant="ghost" size="xs" disabled={readOnly} onClick={() => setHaloFor(p.key)}>
                    <ShieldCheck aria-hidden />
                    {th("chooseHaloUser")}
                  </Button>
                </div>
              ) : null}
              {copy ? <p className="text-xs text-muted-foreground">{t("copyLine")}</p> : null}
              {rolesBad ? <p className="text-xs text-destructive">{t("errors.noDocument")}</p> : null}
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={readOnly || signersFull} onClick={() => change(addPerson(people, docs, "signer"))}>
          <Plus aria-hidden />
          {t("add")}
        </Button>
        <Button type="button" variant="outline" disabled={readOnly || copiesFull} onClick={() => change(addPerson(people, docs, "copy"))}>
          <Plus aria-hidden />
          {t("addCopy")}
        </Button>
      </div>
      {signersFull ? (
        <p className="text-xs text-muted-foreground" role="status">
          {hasUpload ? tp("limitRoles", { max: signerLimit }) : tp("limitSigners", { max: signerLimit })}
        </p>
      ) : null}
      {copiesFull ? (
        <p className="text-xs text-muted-foreground" role="status">
          {t("limitCopies", { max: MAX_COPY_RECIPIENTS })}
        </p>
      ) : null}

      {matches.length > 0 ? (
        <section aria-labelledby="env-template-roles" className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
          <div>
            <h3 id="env-template-roles" className="text-sm font-semibold text-foreground">
              {t("template.heading")}
            </h3>
            <p className="text-xs text-muted-foreground">{t("template.hint")}</p>
          </div>
          {matchedDocuments.map((documentId) => (
            <div key={documentId} className="space-y-2">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{titleOf(documentId)}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {matches
                  .filter((m) => m.documentId === documentId)
                  .map((m) => (
                    <div key={m.roleKey} className="space-y-1">
                      <label htmlFor={`match-${documentId}-${m.roleKey}`} className="block truncate text-xs font-medium text-foreground">
                        {m.roleLabel}
                      </label>
                      <select
                        id={`match-${documentId}-${m.roleKey}`}
                        className={SELECT}
                        value={m.personKey ?? ""}
                        disabled={readOnly}
                        onChange={(e) => change(setTemplateMatch(people, documentId, m.roleKey, e.target.value || null))}
                      >
                        <option value="">{t("template.nobody")}</option>
                        {signers.map((p) => (
                          <option key={p.key} value={p.key}>
                            {nameOf(p, people.indexOf(p))}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {coverage.length > 0 ? (
        <ul className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground" aria-label={t("conflictsLabel")}>
          {coverage.map((c) => (
            <li key={`${c.documentId}-${c.roleKey}`}>{t(c.people === 0 ? "roleNobody" : "roleTwo", { role: labelOf(c.documentId, c.roleKey), document: titleOf(c.documentId) })}</li>
          ))}
        </ul>
      ) : null}

      <Dialog open={haloFor !== null} onOpenChange={(open) => !open && setHaloFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{th("haloUserTitle")}</DialogTitle>
            <DialogDescription>{th("haloUserBody")}</DialogDescription>
          </DialogHeader>
          <div className="min-h-64">
            <HaloUserPicker
              rows={people}
              onPick={(member) => {
                if (haloFor) change(updatePerson(people, haloFor, { fullName: member.full_name.trim() || member.email, email: member.email.trim(), phone: "", channel: "email", internalUserId: member.user_id }, docs));
                setHaloFor(null);
              }}
            />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={asking !== null} onOpenChange={(o) => (o ? undefined : setAsking(null))}>
        <DialogContent>
          {asking ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  <RemovalWords ask={asking} part="title" />
                </DialogTitle>
                <DialogDescription>
                  <RemovalWords ask={asking} part="body" />
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAsking(null)}>
                  {t("removeDialog.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    change(removePerson(people, asking.key));
                    setAsking(null);
                  }}
                >
                  <Trash2 aria-hidden />
                  {t("removeDialog.confirm")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
