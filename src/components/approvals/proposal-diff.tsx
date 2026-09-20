"use client";

import { useTranslations } from "next-intl";

import { buildDiff, type DiffRow } from "@/lib/approvals/rules";
import { interactivePayloadPreviewText, type InteractiveMessagePayload } from "@/lib/whatsapp/interactive";
import { cn } from "@/lib/utils";

type Entity = "tag" | "snippet" | "article";

/** One value, drawn the way its field is meant to be read (swatch, chips, text). */
function ValueCell({ field, value }: { field: string; value: unknown }) {
  const t = useTranslations("Approvals.values");

  if (value === undefined || value === null || value === "") {
    return <span className="text-muted-foreground">{t("empty")}</span>;
  }
  if (field === "color" && typeof value === "string") {
    return (
      <span className="inline-flex items-center gap-2">
        <span
          className="size-4 shrink-0 rounded-full border border-border"
          style={{ backgroundColor: value }}
          aria-hidden
        />
        <code className="text-xs">{value}</code>
      </span>
    );
  }
  if (field === "for_contacts" || field === "for_conversations") {
    return <span>{value ? t("yes") : t("no")}</span>;
  }
  if (field === "kind" && typeof value === "string") {
    return <span>{t(value === "interactive" ? "interactive" : "text")}</span>;
  }
  if (field === "interactive_payload" && typeof value === "object") {
    return (
      <span className="whitespace-pre-wrap break-words">
        {interactivePayloadPreviewText(value as InteractiveMessagePayload)}
      </span>
    );
  }
  if (field === "language" && typeof value === "string") {
    return <span className="uppercase">{value}</span>;
  }
  return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
}

/**
 * Current vs Proposed. For an edit it is two columns and the rows that
 * change are highlighted; for a new item (`current` null) it is a single
 * preview column of the proposed values.
 */
export function ProposalDiff({
  entity,
  current,
  proposed,
  className,
}: {
  entity: Entity;
  current: Record<string, unknown> | null;
  proposed: Record<string, unknown> | null;
  className?: string;
}) {
  const t = useTranslations("Approvals");
  const rows: DiffRow[] = buildDiff(entity, current, proposed);

  if (rows.length === 0) {
    return <p className={cn("text-sm text-muted-foreground", className)}>{t("diff.noValues")}</p>;
  }

  const isEdit = current !== null;
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-card text-sm", className)}>
      <div
        className={cn(
          "grid gap-x-4 border-b border-border bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground",
          isEdit ? "grid-cols-[7rem_1fr_1fr]" : "grid-cols-[7rem_1fr]",
        )}
      >
        <span aria-hidden />
        {isEdit ? <span>{t("diff.current")}</span> : null}
        <span>{isEdit ? t("diff.proposed") : t("diff.preview")}</span>
      </div>
      {rows.map((r) => (
        <div
          key={r.field}
          className={cn(
            "grid items-start gap-x-4 border-b border-border px-3 py-2 last:border-b-0",
            isEdit ? "grid-cols-[7rem_1fr_1fr]" : "grid-cols-[7rem_1fr]",
            isEdit && r.changed && "bg-amber-500/5",
          )}
        >
          <span className="text-xs font-medium text-muted-foreground">
            {t(`fields.${r.field}`)}
          </span>
          {isEdit ? (
            <span className={cn(r.changed && "text-muted-foreground line-through decoration-1")}>
              <ValueCell field={r.field} value={r.from} />
            </span>
          ) : null}
          <span className={cn(isEdit && r.changed && "font-medium")}>
            <ValueCell field={r.field} value={r.to} />
          </span>
        </div>
      ))}
    </div>
  );
}
