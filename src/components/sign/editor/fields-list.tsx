"use client";

import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";

import { roleColorStyle } from "@/lib/sign/client/colors";
import { readingOrder } from "@/lib/sign/client/layout";
import type { FieldType, PlacedField } from "@/lib/sign/pdf/types";
import { SENDER_ROLE } from "@/lib/sign/rules";
import type { SignRole } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

import { FIELD_ICONS } from "./field-icons";

interface FieldsListProps {
  fields: readonly PlacedField[];
  roles: readonly SignRole[];
  selectedKey: string | null;
  issueKeys: ReadonlySet<string>;
  typeLabels: Record<FieldType, string>;
  senderLabel: string;
  onSelect: (key: string) => void;
}

/** Every field in reading order: the way to reach a field without the mouse. */
export function FieldsList({ fields, roles, selectedKey, issueKeys, typeLabels, senderLabel, onSelect }: FieldsListProps) {
  const t = useTranslations("Sign.editor");
  const ordered = useMemo(() => readingOrder(fields), [fields]);
  if (ordered.length === 0) return <p className="p-3 text-sm text-muted-foreground">{t("fieldsList.empty")}</p>;
  return (
    <ul aria-label={t("fieldsList.title")} className="p-1.5">
      {ordered.map((f) => {
        const role = f.role === SENDER_ROLE ? null : roles.find((r) => r.key === f.role);
        const Icon = FIELD_ICONS[f.type];
        const name = f.label?.trim() || (f.merge ? `{{${f.merge}}}` : typeLabels[f.type]);
        return (
          <li key={f.key}>
            <button
              type="button"
              aria-current={f.key === selectedKey ? "true" : undefined}
              onClick={() => onSelect(f.key)}
              style={roleColorStyle(role ? role.color : null)}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", f.key === selectedKey && "bg-muted")}
            >
              <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-[var(--rc-solid)]" />
              <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {role ? role.label : senderLabel} · {t("fieldsList.page", { page: f.page + 1 })}
                </span>
              </span>
              {issueKeys.has(f.key) ? <TriangleAlert className="size-4 shrink-0 text-amber-600" aria-label={t("fieldsList.hasIssue")} /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
