"use client";

// The problems with the form, live: each worded in the reader's language with the name of the field, part or role,
// and a click that takes the sender there. Problems that stop a save come first; then the soft warnings (allowed, but
// probably a slip) and what the server said about the last save.

import { CircleCheck, Info, Trash2, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { formIssueMessageKey, formWarningMessageKey, issueParams, issueTarget, type FormWarning, type IssueContext, type IssueTarget } from "@/lib/sign/client/form-issues";
import type { Issue } from "@/lib/sign/rules";

/** Problems with a box on the pages that the builder can settle by removing the box (`field` is the box's key). */
const REMOVABLE = ["placement_unknown_data", "placement_type_mismatch", "placement_bound_and_fixed"];

interface FormIssuesPanelProps {
  issues: readonly Issue[];
  warnings: readonly FormWarning[];
  ctx: IssueContext;
  onSelect: (target: IssueTarget) => void;
  /** Offered next to a problem with a box on the pages, so it can be settled without leaving the builder (and losing what is not saved). */
  onRemovePlacement?: (placementKey: string) => void;
}

export function FormIssuesPanel({ issues, warnings, ctx, onSelect, onRemovePlacement }: FormIssuesPanelProps) {
  const t = useTranslations("Sign.formBuilder");
  if (issues.length === 0 && warnings.length === 0) {
    return (
      <p className="flex items-start gap-2 p-3 text-sm text-muted-foreground">
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
        {t("issues.none")}
      </p>
    );
  }
  return (
    <div>
      {issues.length > 0 ? (
        <ul className="divide-y" aria-label={t("issues.title")}>
          {issues.map((issue, i) => (
            <li key={`${issue.code}-${issue.field ?? issue.part ?? issue.role ?? ""}-${i}`}>
              <button type="button" className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted" onClick={() => onSelect(issueTarget(issue))}>
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
                <span>{t(formIssueMessageKey(issue.code), { ...issueParams(issue, ctx), code: issue.code })}</span>
              </button>
              {onRemovePlacement && issue.field && REMOVABLE.includes(issue.code) ? (
                <div className="px-3 pb-2 pl-9">
                  <Button type="button" variant="outline" size="xs" onClick={() => onRemovePlacement(issue.field as string)}>
                    <Trash2 />
                    {t("issues.removeBox")}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {warnings.length > 0 ? (
        <>
          <h3 className="border-t bg-muted/40 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("issues.warningsTitle")}</h3>
          <ul className="divide-y" aria-label={t("issues.warningsTitle")}>
            {warnings.map((w, i) => {
              // a placement's key travels in `field`, as it does for the placement issues of validateForm
              const as = { code: w.placement ? "placement_warning" : w.code, field: w.placement ?? w.field, part: w.part, role: w.role, detail: w.detail };
              const params = issueParams(as, ctx);
              return (
                <li key={`${w.code}-${w.field ?? w.part ?? w.placement ?? w.role ?? ""}-${i}`}>
                  <button type="button" className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted" onClick={() => onSelect(issueTarget(as))}>
                    <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span>{t(formWarningMessageKey(w.code), params)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}
