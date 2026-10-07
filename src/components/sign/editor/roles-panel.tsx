"use client";

import { Lock, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ROLE_COLORS, roleColorStyle } from "@/lib/sign/client/colors";
import { partsOfRole } from "@/lib/sign/client/form-edit";
import { canAddRole, countRoleFields, roleKindAllows } from "@/lib/sign/client/layout";
import { pick } from "@/lib/sign/forms/text";
import type { FormDefinition } from "@/lib/sign/forms/types";
import type { PlacedField } from "@/lib/sign/pdf/types";
import { MAX_ROLES } from "@/lib/sign/rules";
import type { SignLocale, SignerKind, SignRole } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

import { FormRow, NativeSelect } from "./form-bits";

interface RolesPanelProps {
  roles: readonly SignRole[];
  fields: readonly PlacedField[];
  /** Forms: the template's form, to show which parts each role holds. */
  form?: FormDefinition | null;
  labelLocale?: SignLocale;
  readOnly: boolean;
  /**
   * A document of a collection that was not made from a template: its roles are the collection's people (`source === "people"`). Those are shown
   * read-only ("from the collection's people") and no role can be added. An older role without that source stays editable.
   */
  rolesLocked?: boolean;
  onAdd: (kind: SignerKind) => void;
  onPatch: (key: string, patch: Partial<Pick<SignRole, "label" | "kind" | "color">>) => void;
  onDelete: (key: string, reassignTo: string | null) => void;
}

export function RolesPanel({ roles, fields, form, labelLocale, readOnly, rolesLocked = false, onAdd, onPatch, onDelete }: RolesPanelProps) {
  const t = useTranslations("Sign.editor");
  return (
    <div className="space-y-3 p-3">
      <p className="text-xs text-muted-foreground">{rolesLocked ? t("roles.fromPeopleHint") : t("roles.intro")}</p>
      <ul className="space-y-3">
        {roles.map((role) =>
          rolesLocked && role.source === "people" ? (
            <LockedRoleCard key={role.key} role={role} fields={fields} />
          ) : (
            <RoleCard key={role.key} role={role} roles={roles} fields={fields} form={form} labelLocale={labelLocale} readOnly={readOnly} onPatch={onPatch} onDelete={onDelete} />
          ),
        )}
        <li className="flex items-center gap-2 rounded-lg border border-dashed p-2" style={roleColorStyle(null)}>
          <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-[var(--rc-solid)]" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("roles.sender")}</p>
            <p className="text-xs text-muted-foreground">{t("roles.senderHint")}</p>
          </div>
        </li>
      </ul>
      {readOnly || rolesLocked ? null : (
        <div className="space-y-1">
          <Button type="button" variant="outline" size="sm" disabled={!canAddRole(roles)} onClick={() => onAdd("signer")}>
            <Plus />
            {t("roles.add")}
          </Button>
          {!canAddRole(roles) ? <p className="text-xs text-muted-foreground">{t("roles.max", { count: MAX_ROLES })}</p> : null}
        </div>
      )}
    </div>
  );
}

/** A role the collection's people made: name, colour and how many fields it has, nothing to change here. */
function LockedRoleCard({ role, fields }: { role: SignRole; fields: readonly PlacedField[] }) {
  const t = useTranslations("Sign.editor");
  return (
    <li data-role-locked className="space-y-1 rounded-lg border p-2.5" style={roleColorStyle(role.color)}>
      <div className="flex items-center gap-2">
        <span aria-hidden className="size-3 shrink-0 rounded-full bg-[var(--rc-solid)]" />
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{role.label}</p>
        <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </div>
      <p className="text-xs text-muted-foreground">
        {t("roles.fromPeople")} · {t("roles.fieldCount", { count: countRoleFields(fields, role.key) })}
      </p>
    </li>
  );
}

function RoleCard({ role, roles, fields, form, labelLocale = "en", readOnly, onPatch, onDelete }: { role: SignRole; roles: readonly SignRole[]; fields: readonly PlacedField[]; form?: FormDefinition | null; labelLocale?: SignLocale; readOnly: boolean } & Pick<RolesPanelProps, "onPatch" | "onDelete">) {
  const t = useTranslations("Sign.editor");
  const tf = useTranslations("Sign.formBuilder");
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState<string>("");
  const count = countRoleFields(fields, role.key);
  const others = roles.filter((r) => r.key !== role.key);
  // fields that cannot belong to a filler: the signing ones
  const blocked = role.kind === "filler" ? fields.filter((f) => f.role === role.key && !roleKindAllows("filler", f.type)).length : 0;
  // forms: the parts this role completes. A role holding parts cannot be deleted from here (its parts would have nobody),
  // and a signer who holds parts but has nothing to sign is named (a filler never signs, so is never named)
  const parts = form ? partsOfRole(form, role.key) : [];
  const noSignature = role.kind === "signer" && parts.length > 0 && !fields.some((f) => f.role === role.key && (f.type === "signature" || f.type === "initials"));

  const startDelete = () => {
    if (count === 0) onDelete(role.key, null);
    else {
      setTarget(others[0]?.key ?? "");
      setConfirming(true);
    }
  };

  return (
    <li className="space-y-2 rounded-lg border p-2.5" style={roleColorStyle(role.color)}>
      <div className="flex items-center gap-2">
        <span aria-hidden className="size-3 shrink-0 rounded-full bg-[var(--rc-solid)]" />
        <label className="sr-only" htmlFor={`role-label-${role.key}`}>
          {t("roles.label")}
        </label>
        <Input id={`role-label-${role.key}`} value={role.label} maxLength={60} disabled={readOnly} onChange={(e) => onPatch(role.key, { label: e.target.value })} aria-invalid={role.label.trim().length === 0} className="h-8" />
        {readOnly ? null : (
          <Button type="button" variant="ghost" size="icon" disabled={parts.length > 0} onClick={startDelete} aria-label={t("roles.delete", { name: role.label })} title={parts.length > 0 ? tf("editor.cannotDeleteRole", { count: parts.length }) : t("roles.delete", { name: role.label })}>
            <Trash2 />
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FormRow label={t("roles.kind")} htmlFor={`role-kind-${role.key}`}>
          <NativeSelect id={`role-kind-${role.key}`} value={role.kind} disabled={readOnly} onChange={(e) => onPatch(role.key, { kind: e.target.value as SignerKind })}>
            <option value="signer">{t("roles.kindSigner")}</option>
            <option value="filler">{t("roles.kindFiller")}</option>
          </NativeSelect>
        </FormRow>
        <div className="space-y-1">
          <span id={`role-color-${role.key}`} className="block text-xs font-medium text-muted-foreground">
            {t("roles.color")}
          </span>
          <div role="radiogroup" aria-labelledby={`role-color-${role.key}`} className="flex flex-wrap gap-1">
            {ROLE_COLORS.map((c, i) => (
              <button
                key={c.name}
                type="button"
                role="radio"
                aria-checked={role.color === i}
                aria-label={t(`colors.${c.name}`)}
                title={t(`colors.${c.name}`)}
                disabled={readOnly}
                onClick={() => onPatch(role.key, { color: i })}
                style={roleColorStyle(i)}
                className={cn("size-5 rounded-full border-2 border-transparent bg-[var(--rc-solid)] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", role.color === i && "border-foreground ring-1 ring-background")}
              />
            ))}
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {role.kind === "filler" ? t("roles.fillerHint") : t("roles.signerHint")} · {t("roles.fieldCount", { count })}
      </p>
      {blocked > 0 ? <p className="text-xs text-destructive">{t("roles.fillerBlocked", { count: blocked })}</p> : null}
      {form ? (
        <div className="space-y-0.5 text-xs">
          <p className="text-muted-foreground">{parts.length > 0 ? tf("editor.holds", { parts: parts.map((p) => pick(p.title, labelLocale) || p.key).join(", "), count: parts.length }) : tf("editor.holdsNone")}</p>
          {parts.length > 0 ? <p className="text-muted-foreground">{tf("editor.cannotDeleteRole", { count: parts.length })}</p> : null}
          {noSignature ? <p className="text-destructive">{tf("editor.signerNoSignature")}</p> : null}
        </div>
      ) : null}
      {confirming ? (
        <div className="space-y-2 rounded-md bg-muted p-2" role="group" aria-label={t("roles.deleteTitle", { name: role.label })}>
          <p className="text-xs">{t("roles.deleteFields", { count, name: role.label })}</p>
          <FormRow label={t("roles.moveTo")} htmlFor={`role-move-${role.key}`}>
            <NativeSelect id={`role-move-${role.key}`} value={target} onChange={(e) => setTarget(e.target.value)}>
              {others.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
              <option value="">{t("roles.removeFields")}</option>
            </NativeSelect>
          </FormRow>
          <div className="flex gap-2">
            <Button type="button" variant="destructive" size="sm" onClick={() => onDelete(role.key, target || null)}>
              {t("roles.confirmDelete")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
