"use client";

// ============================================================
// The form builder, a form WITHOUT a signature (migration 169): who fills the form in. Each person is a role that only fills in
// (nobody signs); a part is given to one of them in its settings. A role a part uses stays; the last one is never removed.
// Collapsed it is one line; the sender names the people when the document is sent.
// ============================================================

import { ChevronDown, Plus, Trash2, Users } from "lucide-react";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { roleColorStyle } from "@/lib/sign/client/colors";
import { addFillerRole, partsOfRole, removeRole, renameRole } from "@/lib/sign/client/form-roles";
import type { FormDefinition } from "@/lib/sign/forms/types";
import { MAX_ROLES } from "@/lib/sign/rules";
import type { SignRole } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

interface FormRolesPanelProps {
  roles: readonly SignRole[];
  form: FormDefinition;
  readOnly: boolean;
  onChange: (next: SignRole[]) => void;
}

export function FormRolesPanel({ roles, form, readOnly, onChange }: FormRolesPanelProps) {
  const t = useTranslations("Sign.formBuilder");
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <section aria-label={t("rolesPanel.title")} className="rounded-lg border bg-card">
      <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-medium">{t("rolesPanel.title")}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{roles.map((r) => r.label || "…").join(", ")}</span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <div id={panelId} className="space-y-3 border-t px-3 py-3">
          <p className="text-xs text-muted-foreground">{t("rolesPanel.hint")}</p>
          <ul className="space-y-2">
            {roles.map((r) => {
              const used = partsOfRole(form, r.key);
              const cannotRemove = roles.length <= 1 || used > 0;
              return (
                <li key={r.key} className="flex flex-wrap items-center gap-2">
                  <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-[var(--rc-solid)]" style={roleColorStyle(r.color)} />
                  <Input
                    value={r.label}
                    maxLength={60}
                    disabled={readOnly}
                    aria-label={t("rolesPanel.nameLabel")}
                    className="h-8 min-w-40 flex-1"
                    onChange={(e) => onChange(renameRole(roles, r.key, e.target.value))}
                  />
                  <span className="w-28 text-xs text-muted-foreground">{t("rolesPanel.parts", { count: used })}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={readOnly || cannotRemove}
                    aria-label={t("rolesPanel.remove", { name: r.label })}
                    title={used > 0 ? t("rolesPanel.removeInUse") : roles.length <= 1 ? t("rolesPanel.removeLast") : undefined}
                    onClick={() => onChange(removeRole(roles, r.key, form))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
          {readOnly ? null : (
            <Button type="button" variant="outline" size="sm" disabled={roles.length >= MAX_ROLES} onClick={() => onChange(addFillerRole(roles, ""))}>
              <Plus aria-hidden />
              {roles.length >= MAX_ROLES ? t("rolesPanel.limit", { max: MAX_ROLES }) : t("rolesPanel.add")}
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
