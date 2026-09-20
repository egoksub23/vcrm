"use client";

import Link from "next/link";
import {
  BookOpen,
  Boxes,
  KeyRound,
  Link2,
  Mail,
  MessageSquare,
  PlugZap,
  ShieldCheck,
  Sparkles,
  Tag,
  User,
  UsersRound,
  Webhook,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { capabilityI18nId, getCapability } from "@/lib/auth/capabilities";
import { entityHref } from "@/lib/audit/client";
import { describeSummary } from "@/lib/audit/summary";
import type { AuditAction, AuditEntry } from "@/lib/audit/types";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------
// Who
// ------------------------------------------------------------

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Avatar + name for a person; a chip for System / Automation / API. */
export function AuditActor({ actor }: { actor: AuditEntry["actor"] }) {
  const t = useTranslations("Audit");

  if (actor.kind !== "user") {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {t(`actorKinds.${actor.kind}`)}
        </span>
        {actor.name ? <span className="truncate text-sm">{actor.name}</span> : null}
      </span>
    );
  }

  const name = actor.name || t("unknownActor");
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Avatar size="sm">
        <AvatarFallback className="text-[10px]">{initials(actor.name)}</AvatarFallback>
      </Avatar>
      <span className={cn("truncate text-sm", !actor.name && "text-muted-foreground italic")}>
        {name}
      </span>
    </span>
  );
}

// ------------------------------------------------------------
// What
// ------------------------------------------------------------

const ACTION_TONE: Readonly<Record<AuditAction, string>> = {
  created: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  updated: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  deleted: "bg-red-500/10 text-red-700 dark:text-red-300",
  restored: "bg-teal-500/10 text-teal-700 dark:text-teal-300",
  applied: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  removed: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
  role_changed: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  capability_changed: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  invited: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  member_removed: "bg-red-500/10 text-red-700 dark:text-red-300",
  team_member_added: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  team_member_removed: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
  approved: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  rejected: "bg-red-500/10 text-red-700 dark:text-red-300",
  connected: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  disconnected: "bg-red-500/10 text-red-700 dark:text-red-300",
  reconnected: "bg-teal-500/10 text-teal-700 dark:text-teal-300",
  linked: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  unlinked: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
};

export function AuditActionBadge({ action }: { action: AuditAction }) {
  const t = useTranslations("Audit");
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        ACTION_TONE[action] ?? "bg-muted text-muted-foreground",
      )}
    >
      {t(`actions.${action}`)}
    </span>
  );
}

const ENTITY_ICON: Readonly<Record<string, LucideIcon>> = {
  tag: Tag,
  snippet: Zap,
  article: BookOpen,
  team: Boxes,
  conversation: MessageSquare,
  contact: User,
  member: UsersRound,
  invitation: Mail,
  role: ShieldCheck,
  channel_config: PlugZap,
  ai_settings: Sparkles,
  api_key: KeyRound,
  webhook: Webhook,
  jira_connection: PlugZap,
  ticket_jira_link: Link2,
};

export function AuditEntityIcon({ type, className }: { type: string; className?: string }) {
  const Icon = ENTITY_ICON[type] ?? Tag;
  return <Icon className={cn("size-4 shrink-0 text-muted-foreground", className)} aria-hidden />;
}

/** Type icon + name of the item; a link while the item still exists. */
export function AuditEntity({ entry }: { entry: AuditEntry }) {
  const t = useTranslations("Audit");
  const href = entityHref(entry);
  const typeLabel = t.has(`entities.${entry.entityType}`)
    ? t(`entities.${entry.entityType}`)
    : entry.entityType;
  const label = entry.entityLabel || typeLabel;

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <AuditEntityIcon type={entry.entityType} />
      <span className="min-w-0">
        <span className="block text-[11px] leading-none text-muted-foreground">{typeLabel}</span>
        {href ? (
          <Link href={href} className="block max-w-[16rem] truncate text-sm font-medium hover:underline">
            {label}
          </Link>
        ) : (
          <span
            className={cn(
              "block max-w-[16rem] truncate text-sm font-medium",
              entry.entityExists === false && "text-muted-foreground line-through decoration-1",
            )}
          >
            {label}
          </span>
        )}
      </span>
    </span>
  );
}

// ------------------------------------------------------------
// Details ("renamed 'VIP' to 'VIP gold'")
// ------------------------------------------------------------

/** A column / setting name in the viewer's language, or the raw name. */
function useFieldLabel() {
  const t = useTranslations("Audit");
  return (field: string) => (t.has(`fields.${field}`) ? t(`fields.${field}`) : field.replace(/_/g, " "));
}

export function AuditSummary({
  action,
  summary,
  className,
}: {
  action: AuditAction;
  summary: Record<string, unknown> | null;
  className?: string;
}) {
  const t = useTranslations("Audit");
  const tCap = useTranslations("Permissions");
  const field = useFieldLabel();

  const parts = describeSummary(action, summary);
  if (parts.length === 0) return null;

  const role = (r: string) => (t.has(`roleNames.${r}`) ? t(`roleNames.${r}`) : r);

  return (
    <span className={cn("text-sm text-muted-foreground", className)}>
      {parts.map((p, i) => {
        let text: string;
        switch (p.type) {
          case "renamed":
            text = t("summary.renamed", { from: p.from, to: p.to });
            break;
          case "changed":
            text = t("summary.changed", { field: field(p.field), from: p.from || "—", to: p.to || "—" });
            break;
          case "edited":
            text = t("summary.edited", { fields: p.fields.map(field).join(", ") });
            break;
          case "published":
            text = t("summary.published");
            break;
          case "language":
            text = t("summary.language", { language: p.language.toUpperCase() });
            break;
          case "tagApplied":
            text = t("summary.tagApplied", { name: p.name });
            break;
          case "roleChange":
            text = t("summary.roleChange", { from: role(p.from), to: role(p.to) });
            break;
          case "capability": {
            const known = getCapability(p.capability) !== undefined;
            const name = known ? tCap(`cap.${capabilityI18nId(p.capability)}.label`) : p.capability;
            text = t(p.granted ? "summary.capabilityOn" : "summary.capabilityOff", { name });
            break;
          }
          case "invitedRole":
            text = t("summary.invitedRole", { role: role(p.role) });
            break;
          case "person":
            text = t("summary.person", { name: p.name });
            break;
          case "untagged":
            text = t("summary.untagged", { contacts: p.contacts, conversations: p.conversations });
            break;
          case "left":
            text = t("summary.left");
            break;
        }
        return (
          <span key={i}>
            {i > 0 ? "; " : null}
            {text}
          </span>
        );
      })}
    </span>
  );
}

// ------------------------------------------------------------
// When
// ------------------------------------------------------------

/** Relative time ("3 hours ago") with the exact time as its tooltip. */
export function AuditTime({ iso }: { iso: string }) {
  const format = useFormatter();
  const date = new Date(iso);
  return (
    <time
      dateTime={iso}
      title={format.dateTime(date, { dateStyle: "medium", timeStyle: "medium" })}
      className="text-sm whitespace-nowrap text-muted-foreground"
    >
      {format.relativeTime(date)}
    </time>
  );
}
