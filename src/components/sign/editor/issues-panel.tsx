"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { issueMessageKey } from "@/lib/sign/client/layout";
import type { FieldType, PlacedField } from "@/lib/sign/pdf/types";
import type { Issue } from "@/lib/sign/rules";
import type { SignRole } from "@/lib/sign/types";

interface IssuesPanelProps {
  issues: readonly Issue[];
  fields: readonly PlacedField[];
  roles: readonly SignRole[];
  typeLabels: Record<FieldType, string>;
  onSelectField: (key: string) => void;
  onSelectRole: (key: string | undefined) => void;
}

export function IssuesPanel({ issues, fields, roles, typeLabels, onSelectField, onSelectRole }: IssuesPanelProps) {
  const t = useTranslations("Sign.editor");
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));
  const roleByKey = new Map(roles.map((r) => [r.key, r]));

  if (issues.length === 0) {
    return (
      <p className="flex items-start gap-2 p-3 text-sm text-muted-foreground">
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
        {t("issues.none")}
      </p>
    );
  }
  return (
    <ul className="divide-y" aria-label={t("issues.title")}>
      {issues.map((issue, i) => {
        const f = issue.field ? fieldByKey.get(issue.field) : undefined;
        const role = issue.role ? roleByKey.get(issue.role) : undefined;
        const message = t(issueMessageKey(issue.code), {
          field: f ? `${f.label?.trim() || typeLabels[f.type]} (${t("issues.onPage", { page: f.page + 1 })})` : "",
          role: role?.label ?? issue.role ?? "",
          detail: issue.detail ?? "",
        });
        return (
          <li key={`${issue.code}-${issue.field ?? issue.role ?? ""}-${i}`}>
            <button
              type="button"
              className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted"
              onClick={() => (f ? onSelectField(f.key) : onSelectRole(issue.role))}
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
              <span>{message}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
