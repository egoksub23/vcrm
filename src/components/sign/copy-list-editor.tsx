"use client";

// ============================================================
// Doc Sign: the people who RECEIVE A COPY as a list the sender edits before anything is saved (migration 176): the list a bulk send puts on every
// document it makes, and the list a registration form puts on every document a submission starts. Each is a name and an email (a contact can be
// chosen for the name), at most 10, each address once. They are not signers. The rows are the same `CopyRow`s the document detail uses, and the
// rules are `copy-form.ts`'s: a person who is started but not complete is flagged once the sender has tried to go on (`showInvalid`), and an
// address listed twice, or one that also signs, is named at once as left out of the save. The words are `Sign.copyList`; the parent gives the one
// sentence that is its own (what this list does there) as `help`.
// ============================================================

import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { PersonNameInput } from "@/components/sign/send/person-name-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addCopy, canAddCopy, copyFlags, copyNotices, fillFromContact, removeCopy, updateCopy, type CopyRow } from "@/lib/sign/client/copy-form";
import { MAX_COPY_RECIPIENTS } from "@/lib/sign/copy-list";

interface Props {
  /** A prefix for the ids of the boxes (two lists never share a screen, but two screens may be tested together). */
  idPrefix: string;
  rows: readonly CopyRow[];
  onChange: (rows: CopyRow[]) => void;
  /** The sender has tried to go on or to save: a person who is started but not complete is flagged. */
  showInvalid?: boolean;
  /** Addresses that sign every document (the fixed people of a bulk send, the other people of a registration form): a copy person with one of them is named as left out. */
  signerEmails?: readonly string[];
  /** What this list does on this screen, one sentence under the title. */
  help: string;
  disabled?: boolean;
}

export function CopyListEditor({ idPrefix, rows, onChange, showInvalid = false, signerEmails = [], help, disabled = false }: Props) {
  const t = useTranslations("Sign.copyList");
  const notices = copyNotices(rows, signerEmails);
  const full = !canAddCopy(rows);
  const titleId = `${idPrefix}-title`;

  /** The sentence about one person that is not a missing value: left out because they sign, or because the address is already above. */
  const noticeFor = (index: number): string | null => {
    const n = notices.find((x) => x.index === index);
    if (!n) return null;
    if (n.kind === "signer") return t("signer");
    // the first of the same address is kept; the ones after it are left out
    return n.positions[0] === index + 1 ? null : t("duplicate");
  };

  return (
    <div role="group" aria-labelledby={titleId} data-copy-list className="space-y-3">
      <div>
        <h3 id={titleId} className="text-sm font-medium text-foreground">
          {t("title")}
        </h3>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>

      {rows.length > 0 ? (
        <ul className="space-y-2" aria-label={t("title")}>
          {rows.map((row, index) => {
            const flags = copyFlags(row);
            const nameBad = showInvalid && flags.name && (row.fullName.trim() !== "" || row.email.trim() !== "");
            const emailBad = showInvalid && flags.email && (row.fullName.trim() !== "" || row.email.trim() !== "");
            const notice = noticeFor(index);
            const nameId = `${idPrefix}-name-${row.key}`;
            const emailId = `${idPrefix}-email-${row.key}`;
            return (
              <li key={row.key} data-copy-row className="grid gap-3 rounded-lg border border-border bg-card p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
                <div className="space-y-1">
                  <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground">
                    {t("fullName")}
                  </label>
                  <PersonNameInput
                    id={nameId}
                    value={row.fullName}
                    invalid={nameBad}
                    disabled={disabled}
                    onChange={(fullName) => onChange(updateCopy(rows, row.key, { fullName }))}
                    onPickContact={(c) => onChange(updateCopy(rows, row.key, fillFromContact(c, row)))}
                  />
                  {nameBad ? (
                    <p role="alert" className="text-xs text-destructive">
                      {t("nameRequired")}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <label htmlFor={emailId} className="text-xs font-medium text-muted-foreground">
                    {t("email")}
                  </label>
                  <Input id={emailId} type="email" value={row.email} maxLength={254} autoComplete="off" disabled={disabled} aria-invalid={emailBad} onChange={(e) => onChange(updateCopy(rows, row.key, { email: e.target.value }))} />
                  {emailBad ? (
                    <p role="alert" className="text-xs text-destructive">
                      {t("emailInvalid")}
                    </p>
                  ) : null}
                </div>
                <Button type="button" variant="ghost" size="sm" className="sm:mt-5" disabled={disabled} aria-label={t("remove", { number: index + 1 })} onClick={() => onChange(removeCopy(rows, row.key))}>
                  <Trash2 aria-hidden />
                </Button>
                {notice ? (
                  <p data-copy-notice className="text-xs text-muted-foreground sm:col-span-3">
                    {notice}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={disabled || full} onClick={() => onChange(addCopy(rows))}>
          <Plus aria-hidden />
          {t("add")}
        </Button>
        <p className="text-xs text-muted-foreground">{full ? t("limit", { max: MAX_COPY_RECIPIENTS }) : t("count", { count: rows.length, max: MAX_COPY_RECIPIENTS })}</p>
      </div>
    </div>
  );
}
