"use client";

// ============================================================
// KYC review, the filters over the list of checks.
//
// review_status, doc_type, created_from, created_to are server-side — changing them triggers a fresh fetch.
// result (validation_status) is client-side.
//
// Pending is the default and needs no date range. Every other status requires both dates
// before a fetch can be made (dateRangeRequired). The Apply button is shown when dates are
// needed but the fetch has not yet been triggered.
// ============================================================

import { useTranslations } from "next-intl";

import { KYC_DOC_TYPES, KYC_REVIEW_STATUSES, type KycDocType, type KycReviewStatus } from "@/lib/kyc/types";
import { Button } from "@/components/ui/button";

import { DEFAULT_FILTERS, canFetch, dateRangeRequired, isDefaultFilters, type KycFilters } from "./helpers";
import { humanStatus } from "./parts";

const SELECT =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

const DATE_INPUT =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

const REVIEW_STATUSES: Array<KycReviewStatus | "all"> = ["pending", "all", ...KYC_REVIEW_STATUSES.filter((s) => s !== "pending")];

export function FilterBar({
  filters,
  results,
  onChange,
  disabled,
}: {
  filters: KycFilters;
  results: readonly string[];
  onChange: (next: KycFilters) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("Kyc.filters");
  const set = (patch: Partial<KycFilters>) => onChange({ ...filters, ...patch });
  const any = !isDefaultFilters(filters);
  const needsDates = dateRangeRequired(filters);
  const ready = canFetch(filters);

  return (
    <div className="space-y-2" role="group" aria-label={t("label")}>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        {/* Review status — always first; changing it may show/hide the date row */}
        <div className="min-w-0">
          <label htmlFor="kyc-filter-review" className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("review")}
          </label>
          <select
            id="kyc-filter-review"
            className={SELECT}
            value={filters.reviewStatus}
            disabled={disabled}
            onChange={(e) => {
              const reviewStatus = e.target.value as KycReviewStatus | "all";
              // Switching to pending clears the dates; switching away keeps them if already set.
              set({ reviewStatus, dateFrom: reviewStatus === "pending" ? "" : filters.dateFrom, dateTo: reviewStatus === "pending" ? "" : filters.dateTo });
            }}
          >
            {REVIEW_STATUSES.map((r) => (
              <option key={r} value={r}>
                {t(`reviews.${r}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0">
          <label htmlFor="kyc-filter-result" className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("result")}
          </label>
          <select id="kyc-filter-result" className={SELECT} value={filters.result} disabled={disabled} onChange={(e) => set({ result: e.target.value })}>
            <option value="">{t("anyResult")}</option>
            {results.map((r) => (
              <option key={r} value={r}>
                {humanStatus(r)}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0">
          <label htmlFor="kyc-filter-type" className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("docType")}
          </label>
          <select
            id="kyc-filter-type"
            className={SELECT}
            value={filters.docType}
            disabled={disabled}
            onChange={(e) => set({ docType: e.target.value as "" | KycDocType })}
          >
            <option value="">{t("anyType")}</option>
            {KYC_DOC_TYPES.map((d) => (
              <option key={d} value={d}>
                {t(`types.${d}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Date range — required for every status except pending */}
      {needsDates ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="min-w-0">
            <label htmlFor="kyc-filter-date-from" className="mb-1 block text-xs font-medium text-muted-foreground">
              {t("dateFrom")}
            </label>
            <input
              id="kyc-filter-date-from"
              type="date"
              className={DATE_INPUT}
              value={filters.dateFrom}
              max={filters.dateTo || undefined}
              disabled={disabled}
              onChange={(e) => set({ dateFrom: e.target.value })}
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="kyc-filter-date-to" className="mb-1 block text-xs font-medium text-muted-foreground">
              {t("dateTo")}
            </label>
            <input
              id="kyc-filter-date-to"
              type="date"
              className={DATE_INPUT}
              value={filters.dateTo}
              min={filters.dateFrom || undefined}
              disabled={disabled}
              onChange={(e) => set({ dateTo: e.target.value })}
            />
          </div>
        </div>
      ) : null}

      {/* Apply / Clear row */}
      <div className="flex items-center gap-3">
        {needsDates && !ready ? (
          <p className="text-xs text-muted-foreground" role="status">
            {t("dateRequired")}
          </p>
        ) : null}
        {any ? (
          <button
            type="button"
            onClick={() => onChange(DEFAULT_FILTERS)}
            disabled={disabled}
            className="ms-auto text-xs text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {t("clear")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
