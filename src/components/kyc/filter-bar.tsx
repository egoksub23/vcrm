"use client";

// ============================================================
// KYC review, the filters over the list of checks.
//
// Only ONE of them is a filter the back end can apply: the document kind (`doc_type`). Picking a kind therefore asks the back end for a fresh list.
// "Needs review / Approved / Rejected" and the result word are applied by the screen over the checks it has, and the screen reads further pages by
// itself until it has enough of them — the back end ignores every filter it is sent except the friend id and the kind.
// ============================================================

import { useTranslations } from "next-intl";

import { KYC_DOC_TYPES, type KycDocType } from "@/lib/kyc/types";

import { DEFAULT_FILTERS, isDefaultFilters, type KycFilters, type ReviewFilter } from "./helpers";
import { humanStatus } from "./parts";

const SELECT =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

const REVIEWS: readonly ReviewFilter[] = ["all", "pending", "approved", "rejected"];

export function FilterBar({
  filters,
  results,
  onChange,
  disabled,
}: {
  filters: KycFilters;
  /** The status words seen in the checks already loaded, to offer under "Result". */
  results: readonly string[];
  onChange: (next: KycFilters) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("Kyc.filters");
  const set = (patch: Partial<KycFilters>) => onChange({ ...filters, ...patch });
  // "Clear filters" goes back to what the page opens on (Needs review), so it is offered whenever the filters differ from that.
  const any = !isDefaultFilters(filters);

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-3" role="group" aria-label={t("label")}>
      <div className="min-w-0">
        <label htmlFor="kyc-filter-review" className="mb-1 block text-xs font-medium text-muted-foreground">
          {t("review")}
        </label>
        <select
          id="kyc-filter-review"
          className={SELECT}
          value={filters.review}
          disabled={disabled}
          onChange={(e) => set({ review: e.target.value as ReviewFilter })}
        >
          {REVIEWS.map((r) => (
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

      {any ? (
        <div className="col-span-2 lg:col-span-3">
          <button
            type="button"
            onClick={() => onChange(DEFAULT_FILTERS)}
            disabled={disabled}
            className="text-xs text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {t("clear")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
