"use client";

import { Fragment, useState } from "react";
import { Plus, UserPlus, Users } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MAX_SIGNERS } from "@/lib/sign/rules";
import { addCopy, canAddCopy, copyNotices, copyToSigner, removeCopy, signerToCopy, updateCopy, type CopyNotice, type CopyRow } from "@/lib/sign/client/copy-form";
import { MAX_COPY_RECIPIENTS } from "@/lib/sign/envelopes";
import { addRow, asHaloUser, dropOnRow, duplicateEmails, groupByStep, moveStep, removeRow, rolesWithoutPeople, setStep, updateRow, type SignerRow } from "@/lib/sign/client/signers-form";
import type { FormDefinition } from "@/lib/sign/forms/types";
import type { SignMode, SignRole } from "@/lib/sign/types";
import { ContactPicker } from "./contact-picker";
import { CopyRowEditor } from "./copy-row";
import { FormRolesCard } from "./form-roles-card";
import { HaloUserPicker } from "./halo-user-picker";
import { SignerRowEditor } from "./signer-row";

interface Props {
  roles: readonly SignRole[];
  rows: readonly SignerRow[];
  signInOrder: boolean;
  /** Show every missing value now (the sender tried to move on). */
  showInvalid: boolean;
  whatsappConfigured: boolean | null;
  readOnly: boolean;
  onRows: (next: SignerRow[]) => void;
  onSignInOrder: (value: boolean) => void;
  onGoToFields: () => void;
  /** Forms: the document's form, so each role shows the parts it holds. */
  form?: FormDefinition | null;
  /** A form without a signature (migration 169): nobody signs, so the words say "fills in" and "submits". */
  mode?: SignMode;
  /** Migration 175: the people who receive the signed copy (not signers). Absent, with `onCopies`, there is no copy section and no type dropdown. */
  copies?: readonly CopyRow[];
  onCopies?: (next: CopyRow[]) => void;
}

/**
 * Step 2: who signs. A row for each person, the order switch, and the people to add from the contacts. Below the people who must sign,
 * the people who only receive the signed copy (they need no roles, so they can be added before any field is placed).
 */
export function PeopleStep({ roles, rows, signInOrder, showInvalid, whatsappConfigured, readOnly, onRows, onSignInOrder, onGoToFields, form, mode, copies, onCopies }: Props) {
  const t = useTranslations("Sign.send.people");
  const tc = useTranslations("Sign.send.copies");
  const formOnly = mode === "form";
  // a form without a signature has nobody who signs: no copy section there
  const copyEnabled = !!onCopies && !formOnly;
  const copyList = copies ?? [];
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [contactsOpen, setContactsOpen] = useState(false);
  /** The row a Halo user is being chosen for. */
  const [haloFor, setHaloFor] = useState<string | null>(null);

  const emptyState = (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Users className="size-5" aria-hidden />
      </div>
      <h2 className="text-base font-semibold text-foreground">{t("noRolesTitle")}</h2>
      <p className="text-sm text-muted-foreground">{t("noRolesBody")}</p>
      <Button type="button" onClick={onGoToFields}>
        {t("goToFields")}
      </Button>
    </div>
  );

  // the people who receive a copy: kept in their own list, after the people who must sign
  const copyProblems = copyNotices(copyList, rows.map((r) => r.email));
  const copyNoticeText = (n: CopyNotice): string => (n.kind === "signer" ? tc("isSigner", { email: n.email }) : tc("sameEmail", { email: n.email, a: n.positions[0], b: n.positions[1] }));
  const signFull = rows.length >= MAX_SIGNERS;
  const copySection = copyEnabled ? (
    <section aria-labelledby="people-copies-heading" data-copy-section className="space-y-3">
      <div>
        <h3 id="people-copies-heading" className="text-sm font-semibold text-foreground">
          {tc("heading")}
        </h3>
        <p className="text-xs text-muted-foreground">{tc("help")}</p>
      </div>
      <ul className="space-y-2" aria-label={tc("heading")}>
        {copyList.map((c, i) => {
          const notice = copyProblems.find((n) => n.index === i);
          return (
            <CopyRowEditor
              key={c.key}
              row={c}
              index={i}
              showInvalid={showInvalid}
              notice={notice ? copyNoticeText(notice) : null}
              readOnly={readOnly}
              canSign={roles.length > 0}
              signFull={signFull}
              onChange={(patch) => onCopies?.(updateCopy(copyList, c.key, patch))}
              onRemove={() => onCopies?.(removeCopy(copyList, c.key))}
              onMustSign={() => {
                const moved = copyToSigner(rows, copyList, roles, c.key);
                onRows(moved.rows);
                onCopies?.(moved.copies);
              }}
            />
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={readOnly || !canAddCopy(copyList)} onClick={() => onCopies?.(addCopy(copyList))}>
          <Plus aria-hidden />
          {tc("add")}
        </Button>
        {!canAddCopy(copyList) ? <p className="text-xs text-muted-foreground">{tc("limit", { max: MAX_COPY_RECIPIENTS })}</p> : null}
      </div>
    </section>
  ) : null;

  if (roles.length === 0) {
    return copySection ? (
      <div className="space-y-8">
        {emptyState}
        {copySection}
      </div>
    ) : (
      emptyState
    );
  }

  const dupes = duplicateEmails(rows);
  const noticeFor = (index: number): { text: string; blocking: boolean } | null => {
    const d = dupes.find((x) => x.positions.includes(index + 1));
    if (!d) return null;
    const [a, b] = d.positions;
    return signInOrder ? { text: t(formOnly ? "sameEmailOrderedForm" : "sameEmailOrdered", { email: d.email, a, b }), blocking: true } : { text: t("sameEmailWarning", { email: d.email }), blocking: false };
  };
  const idle = rolesWithoutPeople(rows, roles);
  const full = rows.length >= MAX_SIGNERS;

  const dropOn = (targetKey: string) => {
    // dropped next to another person: into a step of their own just before or after that person's step
    if (dragKey && dragKey !== targetKey) onRows(dropOnRow(rows, dragKey, targetKey));
    setDragKey(null);
    setOverKey(null);
  };

  // with signing order the people are listed step by step; without it, as they were added
  const groups = signInOrder ? groupByStep(rows) : [{ step: 0, rows: [...rows] }];
  let shownIndex = -1;

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-xl border border-border bg-card p-4">
        <label className="flex cursor-pointer items-start gap-2.5">
          <Checkbox className="mt-0.5" checked={signInOrder} disabled={readOnly} onCheckedChange={(c) => onSignInOrder(!!c)} />
          <span>
            <span className="block text-sm font-medium text-foreground">{t(formOnly ? "needsOrderForm" : "needsOrder")}</span>
            <span className="block text-xs text-muted-foreground">{signInOrder ? t(formOnly ? "needsOrderOnForm" : "needsOrderOn") : t(formOnly ? "needsOrderOffForm" : "needsOrderOff")}</span>
          </span>
        </label>
      </div>

      {form && form.parts.length > 0 ? <FormRolesCard form={form} roles={roles} rows={rows} /> : null}

      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t(formOnly ? "emptyForm" : "empty")}</p> : null}

      <ul className="space-y-2" aria-label={t("listLabel")}>
        {groups.map((group) => (
          <Fragment key={group.step}>
            {signInOrder ? (
              <li className="list-none pt-1 text-xs font-semibold text-muted-foreground" data-step={group.step}>
                {t("stepHeading", { step: group.step, count: group.rows.length })}
              </li>
            ) : null}
            {group.rows.map((row) => {
              const index = ++shownIndex;
              return (
                <SignerRowEditor
                  key={row.key}
                  row={row}
                  index={index}
                  count={rows.length}
                  roles={roles}
                  ordered={signInOrder}
                  showInvalid={showInvalid}
                  notice={noticeFor(index)}
                  whatsappConfigured={whatsappConfigured}
                  readOnly={readOnly}
                  dragging={dragKey === row.key}
                  dropTarget={!!dragKey && overKey === row.key && dragKey !== row.key}
                  onChange={(patch) => onRows(updateRow(rows, row.key, patch))}
                  onRemove={() => onRows(removeRow(rows, row.key))}
                  onMove={(delta) => onRows(moveStep(rows, row.key, delta < 0 ? -1 : 1))}
                  onStep={(step) => onRows(setStep(rows, row.key, step))}
                  onChooseHalo={() => setHaloFor(row.key)}
                  onReceiveCopy={
                    copyEnabled
                      ? () => {
                          const moved = signerToCopy(rows, copyList, row.key);
                          onRows(moved.rows);
                          onCopies?.(moved.copies);
                        }
                      : undefined
                  }
                  copyFull={!canAddCopy(copyList)}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", row.key);
                    setDragKey(row.key);
                  }}
                  onDragOver={(e) => {
                    if (!dragKey) return;
                    e.preventDefault();
                    if (overKey !== row.key) setOverKey(row.key);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    dropOn(row.key);
                  }}
                  onDragEnd={() => {
                    setDragKey(null);
                    setOverKey(null);
                  }}
                />
              );
            })}
          </Fragment>
        ))}
      </ul>

      {idle.length > 0 && rows.length > 0 ? <p className="text-xs text-amber-700 dark:text-amber-300">{t("rolesWithoutPeople", { roles: idle.map((r) => r.label).join(", "), count: idle.length })}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={readOnly || full} onClick={() => onRows(addRow(rows, roles))}>
          <Plus aria-hidden />
          {t("addPerson")}
        </Button>
        <Button type="button" variant="outline" disabled={readOnly || full} onClick={() => setContactsOpen(true)}>
          <UserPlus aria-hidden />
          {t("fromContacts")}
        </Button>
        {full ? <p className="text-xs text-muted-foreground">{t("limitReached", { max: MAX_SIGNERS })}</p> : null}
      </div>

      {copySection}

      <Dialog open={haloFor !== null} onOpenChange={(open) => !open && setHaloFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("haloUserTitle")}</DialogTitle>
            <DialogDescription>{t("haloUserBody")}</DialogDescription>
          </DialogHeader>
          <div className="min-h-64">
            <HaloUserPicker
              rows={rows}
              onPick={(member) => {
                if (haloFor) onRows(updateRow(rows, haloFor, asHaloUser(member)));
                setHaloFor(null);
              }}
            />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={contactsOpen} onOpenChange={setContactsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("fromContactsTitle")}</DialogTitle>
            <DialogDescription>{t("fromContactsBody")}</DialogDescription>
          </DialogHeader>
          <div className="min-h-64">
            <ContactPicker
              contactId={null}
              onChange={(c) => {
                if (!c) return;
                onRows(addRow(rows, roles, { fullName: c.name?.trim() ?? "", email: c.email?.trim() ?? "", phone: c.phone?.trim() ?? "" }));
                setContactsOpen(false);
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
