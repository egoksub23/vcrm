"use client";

// ============================================================
// Doc Sign, the summary beside (desktop) or above (phone, collapsible) the steps: the process as it stands. The documents with a mark for how
// much each has, the people with their type and how many blocks are theirs, and a short "What is left" checklist that turns green as the sender
// goes (an item that is not done is a button that goes there). The same component for a document on its own and for a collection.
// ============================================================

import { Check, ChevronDown, Circle, FileText, Mail, PenLine } from "lucide-react";
import { useTranslations } from "next-intl";

import { ROLE_CLASS, roleColorStyle } from "@/lib/sign/client/colors";
import type { LeftItem, ProcessSummary as Summary, StepId } from "@/lib/sign/client/process";
import { cn } from "@/lib/utils";

interface Props {
  summary: Summary;
  kind: "single" | "collection";
  onGo: (step: StepId, documentId?: string) => void;
}

function SummaryBody({ summary, kind, onGo }: Props) {
  const t = useTranslations("Sign.process.summary");
  const tl = useTranslations("Sign.process.left");
  const tp = useTranslations("Sign.send.envelope.people");
  const allDone = summary.left.every((i) => i.done);

  const leftText = (i: LeftItem): string => tl(i.id === "documents" ? (kind === "single" ? "documentsSingle" : "documentsCollection") : i.id, { count: i.count ?? 0 });

  return (
    <div className="space-y-5 text-sm">
      <section aria-labelledby="sum-docs" className="space-y-2">
        <h3 id="sum-docs" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t("documents")}
        </h3>
        {summary.documents.length === 0 ? (
          <p className="text-muted-foreground">{t("noDocuments")}</p>
        ) : (
          <ul className="space-y-1.5">
            {summary.documents.map((d) => (
              <li key={d.id} className="flex items-start gap-2" data-doc-state={d.state}>
                <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground">{d.title}</span>
                  <span className="block text-xs text-muted-foreground">{t("blocks", { count: d.blocks })}</span>
                  {/* who signs which document: a person with no block on one is not asked to sign it, and the sender sees that before sending */}
                  {summary.counts.signers > 1 && d.people.length > 0 ? (
                    <ul className="mt-0.5 space-y-0.5" data-doc-people={d.id}>
                      {d.people.map((p, i) => (
                        <li key={p.key} className="flex items-center gap-1.5 text-xs text-muted-foreground" data-person={p.key} data-blocks={p.blocks}>
                          <span style={roleColorStyle(p.color)} className={cn("size-2 shrink-0 rounded-full", ROLE_CLASS.dot)} aria-hidden />
                          <span className="min-w-0 truncate">{`${p.name || tp("personN", { n: i + 1 })}: ${p.blocks > 0 ? t("blocks", { count: p.blocks }) : t("noBlocks")}`}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </span>
                {d.state === "ready" ? <Check className="mt-0.5 size-4 shrink-0 text-[light-dark(#059669,#34d399)]" aria-label={t("ready")} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="sum-people" className="space-y-2">
        <h3 id="sum-people" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t("people")}
        </h3>
        {summary.people.length === 0 ? (
          <p className="text-muted-foreground">{t("noPeople")}</p>
        ) : (
          <ul className="space-y-1.5">
            {summary.people.map((p, i) => (
              <li key={p.key} className="flex items-start gap-2" data-person-type={p.type}>
                {p.type === "signer" ? (
                  <span style={roleColorStyle(p.color)} className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", ROLE_CLASS.dot)} aria-hidden />
                ) : (
                  <Mail className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground">{p.name || tp("personN", { n: i + 1 })}</span>
                  <span className="block text-xs text-muted-foreground">{p.type === "signer" ? `${t("mustSign")} · ${t("blocks", { count: p.blocks })}` : t("copy")}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="sum-left" className="space-y-2">
        <h3 id="sum-left" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {tl("heading")}
        </h3>
        {allDone ? <p className="text-[light-dark(#047857,#6ee7b7)]">{tl("allDone")}</p> : null}
        <ul className="space-y-1">
          {summary.left.map((i) => (
            <li key={i.id} data-left={i.id} data-done={i.done ? "true" : "false"}>
              {i.done ? (
                <span className="flex items-start gap-2 text-[light-dark(#047857,#6ee7b7)]">
                  <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>{leftText(i)}</span>
                  <span className="sr-only">{tl("doneMark")}</span>
                </span>
              ) : (
                <button type="button" onClick={() => onGo(i.step, i.documentId)} className="flex w-full items-start gap-2 rounded-md text-left text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                  <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span>{leftText(i)}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** The summary: a card beside the steps on a wide screen; a collapsible one above the footer on a phone. */
export function ProcessSummary(props: Props) {
  const t = useTranslations("Sign.process.summary");
  const left = props.summary.left.filter((i) => !i.done).length;
  return (
    <aside aria-label={t("label")} data-process-summary>
      <div className="hidden rounded-xl border border-border bg-card p-4 lg:block">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
          <PenLine className="size-4 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate">{props.summary.title.trim() || t("untitled")}</span>
        </h2>
        <SummaryBody {...props} />
      </div>
      <details className="group rounded-xl border border-border bg-card lg:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-foreground">
          <span className="min-w-0 truncate">
            {t("heading")} <span className="font-normal text-muted-foreground">{left > 0 ? t("leftCount", { count: left }) : t("allDone")}</span>
          </span>
          <ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="border-t border-border p-4">
          <SummaryBody {...props} />
        </div>
      </details>
    </aside>
  );
}
