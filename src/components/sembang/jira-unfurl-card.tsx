"use client";

import { useTranslations } from "next-intl";
import { formatDistanceToNowStrict } from "date-fns";
import { ExternalLink, ShieldAlert } from "lucide-react";

import { categoryTone } from "@/lib/tickets/jira-ui";
import { cn } from "@/lib/utils";
import type { SembangJiraPreview } from "@/types";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="truncate text-[13px] font-medium text-foreground">{children}</dd>
    </div>
  );
}

/**
 * Live Jira issue unfurl — same idea as Slack's Jira app: paste a
 * *.atlassian.net/browse/<KEY> link, get a card with the issue's current
 * status/priority/assignee underneath the message, not just a bare link.
 * `preview.url`/`title`/`domain` (the shared columns every link preview
 * has) supply the "Open in Jira" address, the summary and the site name;
 * `jira` carries the fields only a Jira unfurl has.
 */
export function JiraUnfurlCard({ url, title, domain, jira }: { url: string; title: string | null; domain: string | null; jira: SembangJiraPreview }) {
  const t = useTranslations("Sembang.jiraUnfurl");
  const tone = categoryTone(jira.statusCategory);

  return (
    <div className="mt-1.5 w-fit max-w-sm rounded-lg border border-border bg-card">
      <div className="p-3">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
            <ShieldAlert className="size-3.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <a href={url} target="_blank" rel="noreferrer" className="text-sm font-semibold text-foreground hover:underline">
              {title || jira.key}
            </a>
            <p className="truncate text-[12px] text-muted-foreground">
              {t("subtitle", { type: jira.issueType || t("issue"), key: jira.key, site: domain || t("jiraCloud") })}
            </p>
          </div>
        </div>

        <dl className="mt-2.5 grid grid-cols-3 gap-x-3 gap-y-1.5">
          <Field label={t("status")}>
            {jira.status ? (
              <span
                className={cn(
                  "inline-flex max-w-full items-center truncate rounded-[4px] px-1.5 py-0.5 text-[11px] leading-none font-bold tracking-wide uppercase",
                  tone,
                )}
              >
                {jira.status}
              </span>
            ) : (
              "—"
            )}
          </Field>
          <Field label={t("priority")}>{jira.priority || "—"}</Field>
          <Field label={t("assignee")}>{jira.assignee || t("unassigned")}</Field>
        </dl>
      </div>

      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <span className="text-[11px] text-muted-foreground">
          {jira.updatedAt
            ? t("updated", { when: formatDistanceToNowStrict(new Date(jira.updatedAt), { addSuffix: true }) })
            : ""}
        </span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 text-[12px] font-medium text-white hover:bg-emerald-700"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          {t("openInJira")}
        </a>
      </div>
    </div>
  );
}
