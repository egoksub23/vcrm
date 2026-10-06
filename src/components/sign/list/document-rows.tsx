"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { DocumentStatusBadge } from "@/components/sign/send/status-badge";
import type { SignCategory } from "@/hooks/use-sign-categories";
import type { SignListRow } from "@/hooks/use-sign-documents";
import { DatesText, MetaLine, WaitingText } from "./row-parts";

interface Props {
  rows: readonly SignListRow[];
  categories: readonly SignCategory[];
  now: number;
}

/** The documents as a table (tablets and computers). One row opens its document; the title is the keyboard link. */
export function DocumentTable({ rows, categories, now }: Props) {
  const t = useTranslations("Sign.send.list");
  const router = useRouter();
  return (
    <div className="hidden overflow-hidden rounded-xl border border-border bg-card md:block">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left text-xs font-medium text-muted-foreground">
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
            <tr key={row.id} className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40" onClick={() => router.push(`/sign/${row.id}`)}>
              <td className="max-w-[22rem] px-4 py-3">
                <Link href={`/sign/${row.id}`} className="block truncate font-medium text-foreground outline-none hover:underline focus-visible:underline" onClick={(e) => e.stopPropagation()}>
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
export function DocumentCards({ rows, categories, now }: Props) {
  return (
    <ul className="flex flex-col gap-2 md:hidden">
      {rows.map((row) => (
        <li key={row.id}>
          <Link href={`/sign/${row.id}`} className="block rounded-xl border border-border bg-card p-3 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring">
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
