"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { DocumentStatusBadge } from "@/components/sign/send/status-badge";
import { Checkbox } from "@/components/ui/checkbox";
import type { SignCategory } from "@/hooks/use-sign-categories";
import type { SignListRow } from "@/hooks/use-sign-documents";
import { rowHref } from "@/lib/sign/client/list-merge";
import { allState } from "@/lib/sign/client/selection";
import { DatesText, MetaLine, WaitingText } from "./row-parts";

/** The ticked documents (see use-selection.ts); without it the rows have no tick boxes. */
export interface RowSelection {
  selected: ReadonlySet<string>;
  ids: readonly string[];
  max: number;
  toggle: (id: string) => void;
  toggleAll: (ids: readonly string[], on: boolean) => void;
}

interface Props {
  rows: readonly SignListRow[];
  categories: readonly SignCategory[];
  now: number;
  selection?: RowSelection;
}

/** The tick box of one document. A full selection cannot take another, but a ticked one can always be unticked. */
function RowTick({ row, selection }: { row: SignListRow; selection: RowSelection }) {
  const t = useTranslations("Sign.bulk.list");
  const on = selection.selected.has(row.id);
  return <Checkbox checked={on} disabled={!on && selection.ids.length >= selection.max} aria-label={t("selectRow", { title: row.title })} onCheckedChange={() => selection.toggle(row.id)} />;
}

/** The documents as a table (tablets and computers). One row opens its document; the title is the keyboard link. */
export function DocumentTable({ rows, categories, now, selection }: Props) {
  const t = useTranslations("Sign.send.list");
  const tBulk = useTranslations("Sign.bulk.list");
  // an envelope is not zipped from the list (its documents are, one by one), so it has no tick box and is not in "select all"
  const selectable = rows.filter((r) => r.kind !== "envelope").map((r) => r.id);
  const all = selection ? allState(selection.ids, selectable) : "none";
  const router = useRouter();
  return (
    <div className="hidden overflow-hidden rounded-xl border border-border bg-card md:block">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left text-xs font-medium text-muted-foreground">
            {selection ? (
              <th scope="col" className="w-10 py-2.5 pr-0 pl-4">
                <Checkbox
                  checked={all === "all"}
                  indeterminate={all === "some"}
                  aria-label={tBulk("selectAll")}
                  onCheckedChange={(on) => selection.toggleAll(selectable, !!on)}
                />
              </th>
            ) : null}
            <th scope="col" className="px-4 py-2.5">
              {t("colDocument")}
            </th>
            <th scope="col" className="px-4 py-2.5">
              {t("colWaiting")}
            </th>
            <th scope="col" className="px-4 py-2.5">
              {t("colStatus")}
            </th>
            <th scope="col" className="px-4 py-2.5">
              {t("colDates")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40" onClick={() => router.push(rowHref(row))}>
              {selection ? (
                <td className="w-10 py-3 pr-0 pl-4" onClick={(e) => e.stopPropagation()}>
                  {row.kind === "envelope" ? null : <RowTick row={row} selection={selection} />}
                </td>
              ) : null}
              <td className="max-w-[22rem] px-4 py-3">
                <Link href={rowHref(row)} className="block truncate font-medium text-foreground outline-none hover:underline focus-visible:underline" onClick={(e) => e.stopPropagation()}>
                  {row.title}
                </Link>
                <MetaLine row={row} categories={categories} />
              </td>
              <td className="max-w-[14rem] px-4 py-3">
                <WaitingText row={row} />
              </td>
              <td className="px-4 py-3">
                <DocumentStatusBadge status={row.status} />
              </td>
              <td className="px-4 py-3">
                <DatesText row={row} now={now} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The documents as cards (phones). */
export function DocumentCards({ rows, categories, now, selection }: Props) {
  return (
    <ul className="flex flex-col gap-2 md:hidden">
      {rows.map((row) => (
        <li key={row.id} className="flex items-start gap-2">
          {selection ? (
            <div className="pt-4 pl-1">{row.kind === "envelope" ? <span className="block size-4" aria-hidden /> : <RowTick row={row} selection={selection} />}</div>
          ) : null}
          <Link href={rowHref(row)} className="block min-w-0 flex-1 rounded-xl border border-border bg-card p-3 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 flex-1 truncate font-medium text-foreground">{row.title}</p>
              <DocumentStatusBadge status={row.status} />
            </div>
            <MetaLine row={row} categories={categories} className="mt-0.5" />
            <div className="mt-2 flex items-end justify-between gap-3">
              <WaitingText row={row} />
              <DatesText row={row} now={now} className="shrink-0 text-right" />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
