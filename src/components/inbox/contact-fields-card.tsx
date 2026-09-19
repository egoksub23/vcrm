"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Pencil } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import {
  checkEmail,
  checkPhone,
  checkText,
  hasNonPhoneIdentity,
  type FieldCheck,
} from "@/lib/contacts/contact-fields";
import {
  countryOptions,
  languageName,
  languageOptions,
  regionName,
  withCurrent,
} from "@/lib/contacts/locale-options";
import { Input } from "@/components/ui/input";
import type { Contact } from "@/types";

/**
 * Editable contact fields for the Inbox's right-hand column: click a
 * value to edit it (Enter or clicking away saves, Esc cancels); the two
 * pickers save as soon as you choose. Language is the customer's
 * preferred conversation language — AI drafts and auto-replies answer in
 * it. Viewers see the values read-only.
 */
export function ContactFieldsCard({
  contact,
  canEdit,
  onUpdated,
  phoneAction,
}: {
  contact: Contact;
  canEdit: boolean;
  /** Called with the columns that changed, after a successful save. */
  onUpdated: (contactId: string, patch: Partial<Contact>) => void;
  /** Extra control shown beside the phone value (copy button). */
  phoneAction?: ReactNode;
}) {
  const t = useTranslations("Inbox.contactFields");
  const locale = useLocale();
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const countries = useMemo(
    () => withCurrent(countryOptions(locale), contact.country, (c) => regionName(c, locale)),
    [locale, contact.country],
  );
  const languages = useMemo(
    () => withCurrent(languageOptions(locale), contact.language, (c) => languageName(c, locale)),
    [locale, contact.language],
  );

  /** Write columns to the contact; returns an error message, or null on success. */
  async function save(key: string, patch: Record<string, unknown>): Promise<string | null> {
    setSavingKey(key);
    const { error } = await createClient()
      .from("contacts")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", contact.id);
    setSavingKey(null);
    if (error) {
      console.error("[ContactFieldsCard] save failed:", error);
      return isUniqueViolation(error) ? t("errors.phone_taken") : t("saveFailed");
    }
    onUpdated(contact.id, patch as Partial<Contact>);
    return null;
  }

  const reason = (r: string) => t(`errors.${r}` as Parameters<typeof t>[0]);

  const commit = async <T,>(key: string, check: FieldCheck<T>, column: string, current: unknown) => {
    if (!check.ok) return reason(check.reason);
    if ((check.value ?? null) === (current ?? null) || (check.value === "" && !current)) return null;
    return save(key, { [column]: check.value });
  };

  return (
    <div className="space-y-1">
      <TextRow
        label={t("name")}
        value={contact.name ?? ""}
        placeholder={t("addName")}
        disabled={!canEdit}
        saving={savingKey === "name"}
        onCommit={(v) => commit("name", checkText(v), "name", contact.name)}
      />
      <TextRow
        label={t("phone")}
        value={contact.phone}
        placeholder={t("addPhone")}
        inputMode="tel"
        disabled={!canEdit}
        saving={savingKey === "phone"}
        trailing={phoneAction}
        onCommit={(v) =>
          commit(
            "phone",
            checkPhone(v, { canBeEmpty: hasNonPhoneIdentity(contact) }),
            "phone",
            contact.phone,
          )
        }
      />
      <TextRow
        label={t("email")}
        value={contact.email ?? ""}
        placeholder={t("addEmail")}
        inputMode="email"
        disabled={!canEdit}
        saving={savingKey === "email"}
        onCommit={(v) => commit("email", checkEmail(v), "email", contact.email)}
      />
      <TextRow
        label={t("company")}
        value={contact.company ?? ""}
        placeholder={t("addCompany")}
        disabled={!canEdit}
        saving={savingKey === "company"}
        onCommit={(v) => commit("company", checkText(v), "company", contact.company)}
      />
      <SelectRow
        label={t("country")}
        value={contact.country ?? ""}
        emptyLabel={t("notSet")}
        options={countries}
        disabled={!canEdit}
        saving={savingKey === "country"}
        onChange={async (code) => {
          const err = await save("country", { country: code || null });
          if (err) toast.error(err);
        }}
      />
      <SelectRow
        label={t("language")}
        hint={t("languageHint")}
        value={contact.language ?? ""}
        emptyLabel={t("notSet")}
        options={languages}
        disabled={!canEdit}
        saving={savingKey === "language"}
        onChange={async (code) => {
          const err = await save("language", {
            language: code || null,
            language_source: code ? "manual" : null,
          });
          if (err) toast.error(err);
        }}
      />
    </div>
  );
}

/** Label above, value below — the layout respond.io's contact column uses. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="rounded-md px-1 py-1.5">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5">{children}</div>
      {hint ? <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function TextRow({
  label,
  value,
  placeholder,
  inputMode,
  disabled,
  saving,
  trailing,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder: string;
  inputMode?: "tel" | "email";
  disabled: boolean;
  saving: boolean;
  trailing?: ReactNode;
  /** Returns an error message to show, or null when saved / unchanged. */
  onCommit: (next: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Enter/Esc unmount the input, which can fire a trailing blur — these
  // stop that from saving twice (Enter) or saving a cancelled edit (Esc).
  const inFlight = useRef(false);
  const cancelled = useRef(false);

  const start = () => {
    if (disabled) return;
    setDraft(value);
    setError(null);
    cancelled.current = false;
    setEditing(true);
  };

  const finish = async () => {
    if (inFlight.current || cancelled.current) return;
    inFlight.current = true;
    const err = await onCommit(draft);
    inFlight.current = false;
    if (err) {
      // Stay in edit mode so the value can be fixed; nothing was written.
      setError(err);
      return;
    }
    setEditing(false);
  };

  return (
    <Row label={label}>
      {editing ? (
        <div>
          <Input
            autoFocus
            value={draft}
            inputMode={inputMode}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onBlur={() => {
              // Blur saves; Esc sets the cancelled ref, which finish() honours.
              void finish();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void finish();
              } else if (e.key === "Escape") {
                cancelled.current = true;
                setEditing(false);
                setError(null);
              }
            }}
            aria-invalid={error ? true : undefined}
            className="h-8 text-sm"
          />
          {error ? <p className="mt-1 text-[11px] text-destructive">{error}</p> : null}
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={start}
            disabled={disabled}
            className={cn(
              "group flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-sm",
              disabled ? "cursor-default" : "hover:bg-muted",
            )}
          >
            <span className={cn("truncate", value ? "text-foreground" : "text-muted-foreground")}>
              {value || (disabled ? "—" : placeholder)}
            </span>
            {saving ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
            ) : !disabled ? (
              <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            ) : null}
          </button>
          {trailing}
        </div>
      )}
    </Row>
  );
}

function SelectRow({
  label,
  hint,
  value,
  emptyLabel,
  options,
  disabled,
  saving,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  emptyLabel: string;
  options: { code: string; name: string }[];
  disabled: boolean;
  saving: boolean;
  onChange: (code: string) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <div className="flex items-center gap-1">
        <select
          value={value}
          disabled={disabled || saving}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className={cn(
            "h-8 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1 text-sm outline-none transition-colors",
            "hover:bg-muted focus:border-primary disabled:cursor-default disabled:opacity-100 disabled:hover:bg-transparent",
            value ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <option value="">{emptyLabel}</option>
          {options.map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
            </option>
          ))}
        </select>
        {saving ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" /> : null}
      </div>
    </Row>
  );
}
