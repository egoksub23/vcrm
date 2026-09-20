"use client";

// Settings > Integrations > Jira > Direction & privacy. What flows which way,
// what customer data may leave, the weekly personal-data report Atlassian
// requires, and who may use the link. Presentational: each switch reports its
// change at once.

import Link from "next/link";
import { useTranslations } from "next-intl";

import type { JiraSettings, WebhookStats } from "@/lib/jira/types";
import { DEFAULT_JIRA_SETTINGS } from "@/lib/jira/types";

import { SettingsChip } from "../settings-chip";
import { JiraCard, SwitchRow } from "./jira-form-parts";

export interface JiraDirectionTabProps {
  direction: JiraSettings["direction"];
  privacy: JiraSettings["privacy"];
  personalDataReport: boolean;
  /** "Require signed deliveries" (0.45.0). */
  requireSigned?: boolean;
  /** How deliveries have arrived so far (from the connection row). */
  webhookStats?: WebhookStats | null;
  onRequireSignedChange?: (on: boolean) => void;
  /** The caller holds roles.manage: link to Roles & permissions. */
  canManageRoles: boolean;
  disabled?: boolean;
  onDirectionChange: (key: keyof JiraSettings["direction"], on: boolean) => void;
  onPrivacyChange: (key: keyof JiraSettings["privacy"], on: boolean) => void;
  onPersonalDataReportChange: (on: boolean) => void;
}

const DIRECTION_KEYS = [
  "comments_to_jira",
  "comments_from_jira",
  "status_from_jira",
  "status_to_jira",
  "assignee",
] as const;

const ATTACHMENT_KEYS = ["attachments", "attachments_auto"] as const;

const ACCESS_ROWS = [
  { cap: "connect", roles: ["owner", "admin"] },
  { cap: "link", roles: ["owner", "admin", "agent"] },
  { cap: "share", roles: ["owner", "admin", "agent"] },
] as const;

export function JiraDirectionTab({
  direction,
  privacy,
  personalDataReport,
  requireSigned = false,
  webhookStats,
  onRequireSignedChange,
  canManageRoles,
  disabled,
  onDirectionChange,
  onPrivacyChange,
  onPersonalDataReportChange,
}: JiraDirectionTabProps) {
  const t = useTranslations("Settings.jira.direction");
  const td = useTranslations("Settings.jira.depth");
  const defaults = DEFAULT_JIRA_SETTINGS;
  const unsigned = webhookStats?.unsigned ?? 0;

  return (
    <div className="space-y-4">
      <JiraCard title={t("flow.title")} description={t("flow.description")}>
        <div className="grid gap-3 lg:grid-cols-2">
          {DIRECTION_KEYS.map((key) => (
            <SwitchRow
              key={key}
              label={t(`flow.${key}.label`)}
              hint={t(`flow.${key}.hint`)}
              checked={direction[key]}
              disabled={disabled}
              defaultOn={defaults.direction[key]}
              onChange={(on) => onDirectionChange(key, on)}
            />
          ))}
        </div>
      </JiraCard>

      <JiraCard title={td("flow.attachmentsTitle")} description={td("flow.attachmentsDescription")}>
        <div className="grid gap-3 lg:grid-cols-2">
          {ATTACHMENT_KEYS.map((key) => (
            <SwitchRow
              key={key}
              label={td(`flow.${key}.label`)}
              hint={td(`flow.${key}.hint`)}
              checked={direction[key]}
              disabled={disabled || (key === "attachments_auto" && !direction.attachments)}
              defaultOn={defaults.direction[key]}
              onChange={(on) => onDirectionChange(key, on)}
            />
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{td("flow.attachmentsLimits")}</p>
      </JiraCard>

      <JiraCard title={t("privacy.title")} description={t("privacy.description")}>
        <div className="grid gap-3 lg:grid-cols-2">
          <SwitchRow
            label={t("privacy.include_customer.label")}
            hint={t("privacy.include_customer.hint")}
            warning={t("privacy.include_customer.warning")}
            checked={privacy.include_customer}
            disabled={disabled}
            defaultOn={defaults.privacy.include_customer}
            onChange={(on) => onPrivacyChange("include_customer", on)}
          />
          <SwitchRow
            label={t("privacy.preview_before_send.label")}
            hint={t("privacy.preview_before_send.hint")}
            checked={privacy.preview_before_send}
            disabled={disabled}
            defaultOn={defaults.privacy.preview_before_send}
            onChange={(on) => onPrivacyChange("preview_before_send", on)}
          />
        </div>
      </JiraCard>

      <JiraCard title={td("webhook.title")} description={td("webhook.description")}>
        {unsigned > 0 ? (
          <p role="status" className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
            {td("webhook.unsignedNote", { unsigned, signed: webhookStats?.signed ?? 0 })}
          </p>
        ) : null}
        <SwitchRow
          label={td("webhook.requireSigned.label")}
          hint={td("webhook.requireSigned.hint")}
          warning={requireSigned ? undefined : td("webhook.requireSigned.warning")}
          checked={requireSigned}
          disabled={disabled || !onRequireSignedChange}
          defaultOn={defaults.webhook.require_signed}
          onChange={(on) => onRequireSignedChange?.(on)}
        />
      </JiraCard>

      <JiraCard title={t("report.title")} description={t("report.description")}>
        <SwitchRow
          label={t("report.label")}
          hint={t("report.hint")}
          checked={personalDataReport}
          disabled={disabled}
          defaultOn={defaults.personal_data_report}
          onChange={onPersonalDataReportChange}
        />
      </JiraCard>

      <JiraCard title={t("access.title")} description={t("access.description")}>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {ACCESS_ROWS.map((row) => (
            <li key={row.cap} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{t(`access.${row.cap}.label`)}</p>
                <p className="text-xs text-muted-foreground">{t(`access.${row.cap}.hint`)}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {row.roles.map((role) => (
                  <SettingsChip key={role} variant={role === "owner" ? "owner" : role === "admin" ? "admin" : "muted"}>
                    {t(`access.roles.${role}`)}
                  </SettingsChip>
                ))}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">{t("access.viewers")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {canManageRoles ? (
            <Link href="/settings?tab=roles" className="font-medium text-primary underline-offset-2 hover:underline">
              {t("access.rolesLink")}
            </Link>
          ) : (
            t("access.rolesAsk")
          )}
        </p>
      </JiraCard>
    </div>
  );
}
