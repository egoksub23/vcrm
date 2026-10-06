"use client";

import { useState } from "react";
import { Plus, UserPlus, Users } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MAX_SIGNERS } from "@/lib/sign/rules";
import { addRow, duplicateEmails, moveRow, moveRowBy, removeRow, rolesWithoutPeople, updateRow, type SignerRow } from "@/lib/sign/client/signers-form";
import type { FormDefinition } from "@/lib/sign/forms/types";
import type { SignRole } from "@/lib/sign/types";
import { ContactPicker } from "./contact-picker";
import { FormRolesCard } from "./form-roles-card";
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
}

/** Step 2: who signs. A row for each person, the order switch, and the people to add from the contacts. */
export function PeopleStep({ roles, rows, signInOrder, showInvalid, whatsappConfigured, readOnly, onRows, onSignInOrder, onGoToFields, form }: Props) {
  const t = useTranslations("Sign.send.people");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [contactsOpen, setContactsOpen] = useState(false);

  if (roles.length === 0) {
    return (
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
  }

  const dupes = duplicateEmails(rows);
  const noticeFor = (index: number): { text: string; blocking: boolean } | null => {
    const d = dupes.find((x) => x.positions.includes(index + 1));
    if (!d) return null;
    const [a, b] = d.positions;
    return signInOrder ? { text: t("sameEmailOrdered", { email: d.email, a, b }), blocking: true } : { text: t("sameEmailWarning", { email: d.email }), blocking: false };
  };
  const idle = rolesWithoutPeople(rows, roles);
  const full = rows.length >= MAX_SIGNERS;

  const dropOn = (targetKey: string) => {
    if (dragKey && dragKey !== targetKey) {
      const from = rows.findIndex((r) => r.key === dragKey);
      const to = rows.findIndex((r) => r.key === targetKey);
      if (from >= 0 && to >= 0) onRows(moveRow(rows, from, to));
    }
    setDragKey(null);
    setOverKey(null);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-xl border border-border bg-card p-4">
        <label className="flex cursor-pointer items-start gap-2.5">
          <Checkbox className="mt-0.5" checked={signInOrder} disabled={readOnly} onCheckedChange={(c) => onSignInOrder(!!c)} />
          <span>
            <span className="block text-sm font-medium text-foreground">{t("needsOrder")}</span>
            <span className="block text-xs text-muted-foreground">{signInOrder ? t("needsOrderOn") : t("needsOrderOff")}</span>
          </span>
        </label>
      </div>

      {form && form.parts.length > 0 ? <FormRolesCard form={form} roles={roles} rows={rows} /> : null}

      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("empty")}</p> : null}

      <ul className="space-y-2" aria-label={t("listLabel")}>
        {rows.map((row, index) => (
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
            onMove={(delta) => onRows(moveRowBy(rows, row.key, delta))}
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
