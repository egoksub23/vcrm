"use client";

// Settings > Approvals (approvals.review). Migration 084 / src/lib/approvals.
// Pending | Decided, a Current vs Proposed view, Approve / Edit then approve /
// Reject (note required), bulk approve, and the "Agents need approval for"
// switch group at the top.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Pencil,
  Tag,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";

import { ProposalDiff } from "@/components/approvals/proposal-diff";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/use-auth";
import { notifyApprovalsChanged, useApprovalsCount } from "@/hooks/use-approvals-count";
import { approveMany, decideApproval, fetchApprovals } from "@/lib/approvals/client";
import { bulkApprovable, changedCount, buildDiff, itemKey } from "@/lib/approvals/rules";
import type { ApprovalErrorCode, ApprovalItem } from "@/lib/approvals/types";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

import { SettingsPanelHead } from "../settings-panel-head";
import { ApprovalsSwitches } from "./approvals-switches";
import { EditApproveDialog, RejectDialog } from "./approval-dialogs";

type Tab = "pending" | "decided";
type RangeDays = "7" | "30" | "90";

const selectClass =
  "h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

const TYPE_ICON: Record<ApprovalItem["entity_type"], LucideIcon> = {
  tag: Tag,
  snippet: Zap,
  article: BookOpen,
};

function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** "tag" | "label" | "both" | "snippet" | "article": what the type chip says. */
function typeKey(item: ApprovalItem): "tag" | "label" | "both" | "snippet" | "article" {
  if (item.entity_type !== "tag") return item.entity_type;
  return item.kind === "label" ? "label" : item.kind === "both" ? "both" : "tag";
}

interface Person {
  id: string;
  name: string;
}

export function ApprovalsPanel() {
  const t = useTranslations("Settings.approvals");
  const tt = useTranslations("Approvals");
  const format = useFormatter();
  const { accountId, loading: authLoading, user } = useAuth();
  const { count: pendingCount, refresh: refreshCount } = useApprovalsCount();

  const [tab, setTab] = useState<Tab>("pending");
  const [type, setType] = useState("");
  const [proposer, setProposer] = useState("");
  const [range, setRange] = useState<RangeDays>("90");
  const [people, setPeople] = useState<Person[]>([]);

  const [items, setItems] = useState<ApprovalItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [rejecting, setRejecting] = useState<ApprovalItem | null>(null);
  const [editing, setEditing] = useState<ApprovalItem | null>(null);

  // People for the "Person" filter.
  useEffect(() => {
    if (authLoading || !accountId) return;
    let cancelled = false;
    createClient()
      .from("profiles")
      .select("user_id, full_name, email")
      .then(({ data }) => {
        if (cancelled) return;
        setPeople(
          ((data ?? []) as { user_id: string; full_name: string | null; email: string | null }[])
            .map((p) => ({ id: p.user_id, name: p.full_name?.trim() || p.email || "" }))
            .filter((p) => p.name)
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [authLoading, accountId]);

  const load = useCallback(async () => {
    const since =
      tab === "decided"
        ? new Date(Date.now() - Number(range) * 24 * 3600 * 1000).toISOString()
        : null;
    const res = await fetchApprovals({ tab, type: type || null, proposer: proposer || null, since });
    if (!res.ok) {
      setFailed(true);
      setItems([]);
      return;
    }
    setFailed(false);
    setItems(res.items);
  }, [tab, type, proposer, range]);

  useEffect(() => {
    if (authLoading || !accountId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems(null);
    void load();
  }, [authLoading, accountId, load]);

  const afterChange = useCallback(async () => {
    setSelected(new Set());
    await load();
    refreshCount();
    notifyApprovalsChanged();
  }, [load, refreshCount]);

  const errorText = (code: ApprovalErrorCode) => tt(`errors.${code}`);

  async function approve(item: ApprovalItem, edited?: Record<string, unknown>) {
    const key = itemKey(item);
    setBusyKey(key);
    const res = await decideApproval({
      entity_type: item.entity_type,
      id: item.entity_id,
      decision: "approve",
      edited: edited && Object.keys(edited).length > 0 ? edited : undefined,
    });
    setBusyKey(null);
    if (!res.ok) {
      toast.error(errorText(res.code));
      if (res.code === "not_pending" || res.code === "not_found") await afterChange();
      return;
    }
    toast.success(
      item.entity_type === "article" ? t("toasts.published") : t("toasts.approved"),
    );
    if (res.warning) toast.warning(res.warning);
    setEditing(null);
    await afterChange();
  }

  async function reject(item: ApprovalItem, note: string) {
    const key = itemKey(item);
    setBusyKey(key);
    const res = await decideApproval({
      entity_type: item.entity_type,
      id: item.entity_id,
      decision: "reject",
      note,
    });
    setBusyKey(null);
    if (!res.ok) {
      toast.error(errorText(res.code));
      if (res.code === "not_pending" || res.code === "not_found") {
        setRejecting(null);
        await afterChange();
      }
      return;
    }
    toast.success(t("toasts.rejected"));
    setRejecting(null);
    await afterChange();
  }

  const list = useMemo(() => items ?? [], [items]);
  const selectable = useMemo(() => bulkApprovable(list), [list]);
  const selectedItems = useMemo(
    () => selectable.filter((i) => selected.has(itemKey(i))),
    [selectable, selected],
  );

  async function approveSelected() {
    if (selectedItems.length === 0) return;
    setBulkBusy(true);
    const res = await approveMany(
      selectedItems.map((i) => ({ entity_type: i.entity_type, id: i.entity_id })),
    );
    setBulkBusy(false);
    if (!res.ok) {
      toast.error(tt("errors.unknown"));
      return;
    }
    if (res.failed > 0) {
      toast.warning(t("toasts.approvedPartial", { approved: res.approved, failed: res.failed }));
    } else {
      toast.success(t("toasts.approvedMany", { count: res.approved }));
    }
    await afterChange();
  }

  function toggle(set: Set<string>, key: string): Set<string> {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }

  const allSelected = selectable.length > 0 && selectedItems.length === selectable.length;

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      <ApprovalsSwitches />

      <Tabs value={tab} onValueChange={(v) => { setTab(v as Tab); setSelected(new Set()); setExpanded(new Set()); }}>
        <TabsList>
          <TabsTrigger value="pending">
            {t("tabs.pending")}
            {pendingCount > 0 ? (
              <span className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-amber-500/15 px-1.5 text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                {pendingCount}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="decided">{t("tabs.decided")}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-center gap-2">
        <select
          className={selectClass}
          value={type}
          onChange={(e) => setType(e.target.value)}
          aria-label={t("filters.type")}
        >
          <option value="">{t("filters.anyType")}</option>
          {(["snippet", "label", "tag", "article"] as const).map((k) => (
            <option key={k} value={k}>
              {tt(`types.${k}`)}
            </option>
          ))}
        </select>
        <select
          className={selectClass}
          value={proposer}
          onChange={(e) => setProposer(e.target.value)}
          aria-label={t("filters.person")}
        >
          <option value="">{t("filters.anyone")}</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {tab === "decided" ? (
          <select
            className={selectClass}
            value={range}
            onChange={(e) => setRange(e.target.value as RangeDays)}
            aria-label={t("filters.range")}
          >
            {(["7", "30", "90"] as const).map((d) => (
              <option key={d} value={d}>
                {t(`filters.range_${d}`)}
              </option>
            ))}
          </select>
        ) : null}

        {tab === "pending" && selectable.length > 0 ? (
          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={allSelected}
                indeterminate={selectedItems.length > 0 && !allSelected}
                onCheckedChange={(c) =>
                  setSelected(c ? new Set(selectable.map(itemKey)) : new Set())
                }
                aria-label={t("actions.selectAll")}
              />
              {t("actions.selectAll")}
            </label>
            <Button
              size="sm"
              onClick={approveSelected}
              disabled={selectedItems.length === 0 || bulkBusy}
            >
              {bulkBusy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              {t("actions.approveSelected", { count: selectedItems.length })}
            </Button>
          </div>
        ) : null}
      </div>

      {items === null ? (
        <div className="flex items-center justify-center rounded-xl border border-border bg-card py-12">
          <Loader2 className="size-6 animate-spin text-primary" aria-label={t("loading")} />
        </div>
      ) : failed ? (
        <div className="rounded-xl border border-border bg-card px-4 py-10 text-center text-sm">
          <p className="text-muted-foreground">{t("loadFailed")}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
            {t("retry")}
          </Button>
        </div>
      ) : list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          {type || proposer ? t("empty.filtered") : t(tab === "pending" ? "empty.pending" : "empty.decided")}
        </p>
      ) : (
        <ul className="space-y-2">
          {list.map((item) => {
            const key = itemKey(item) + (item.decided_at ?? "");
            const rowKey = itemKey(item);
            const isOpen = expanded.has(key);
            const Icon = TYPE_ICON[item.entity_type];
            const busy = busyKey === rowKey;
            const entity = item.entity_type;
            const changes =
              item.action === "edit"
                ? changedCount(buildDiff(entity, item.current, item.proposed))
                : 0;
            const own = !!user && item.proposer_id === user.id;
            return (
              <li key={key} className="rounded-xl border border-border bg-card">
                <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  {tab === "pending" ? (
                    <Checkbox
                      checked={selected.has(rowKey)}
                      onCheckedChange={() => setSelected((s) => toggle(s, rowKey))}
                      aria-label={t("actions.select", { name: item.title ?? "" })}
                      disabled={own}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    onClick={() => setExpanded((s) => toggle(s, key))}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? (
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    ) : (
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <Avatar size="sm">
                      <AvatarFallback className="text-[10px]">{initials(item.proposer_name)}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {item.title || tt("untitled")}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.proposer_name || tt("unknownPerson")}
                        {item.proposed_at ? (
                          <> · {format.relativeTime(new Date(item.proposed_at))}</>
                        ) : null}
                      </span>
                    </span>
                  </button>

                  <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <Icon className="size-3.5" aria-hidden />
                    {tt(`types.${typeKey(item)}`)}
                  </span>
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                      item.action === "new"
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
                    )}
                  >
                    {tt(`actions.${item.action}`)}
                    {changes > 0 ? <> · {changes}</> : null}
                  </span>
                  {tab === "decided" ? (
                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                        item.status === "approved"
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
                      )}
                    >
                      {t(`decided.status.${item.status}`)}
                    </span>
                  ) : null}
                </div>

                {isOpen ? (
                  <div className="space-y-3 border-t border-border px-3 py-3">
                    {entity === "article" ? (
                      <ArticlePreview item={item} tab={tab} />
                    ) : (
                      <ProposalDiff entity={entity} current={item.current} proposed={item.proposed} />
                    )}

                    {tab === "decided" ? (
                      <div className="text-xs text-muted-foreground">
                        <p>
                          {t(item.status === "approved" ? "decided.approvedBy" : "decided.rejectedBy", {
                            name: item.decided_by_name || tt("unknownPerson"),
                          })}
                          {item.decided_at ? <> · {format.dateTime(new Date(item.decided_at), { dateStyle: "medium", timeStyle: "short" })}</> : null}
                        </p>
                        {item.decision_note ? (
                          <p className="mt-1 text-sm text-foreground">
                            {t("decided.note", { note: item.decision_note })}
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" onClick={() => void approve(item)} disabled={busy || own}>
                          {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                          {entity === "article" ? t("actions.publish") : t("actions.approve")}
                        </Button>
                        {entity !== "article" ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditing(item)}
                              disabled={busy || own}
                            >
                              <Pencil className="size-4" />
                              {t("actions.editApprove")}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setRejecting(item)}
                              disabled={busy || own}
                            >
                              <X className="size-4" />
                              {t("actions.reject")}
                            </Button>
                          </>
                        ) : (
                          <Link
                            href={`/knowledge/${item.entity_id}`}
                            className={buttonVariants({ size: "sm", variant: "outline" })}
                          >
                            <ExternalLink className="size-4" />
                            {t("actions.openEditor")}
                          </Link>
                        )}
                        {own ? (
                          <span className="text-xs text-muted-foreground">{t("row.ownProposal")}</span>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {rejecting ? (
        <RejectDialog
          item={rejecting}
          busy={busyKey === itemKey(rejecting)}
          onCancel={() => setRejecting(null)}
          onConfirm={(note) => void reject(rejecting, note)}
        />
      ) : null}
      {editing ? (
        <EditApproveDialog
          item={editing}
          busy={busyKey === itemKey(editing)}
          onCancel={() => setEditing(null)}
          onConfirm={(edited) => void approve(editing, edited)}
        />
      ) : null}
    </section>
  );
}

function ArticlePreview({ item, tab }: { item: ApprovalItem; tab: Tab }) {
  const t = useTranslations("Settings.approvals");
  const text = String((item.proposed as Record<string, unknown> | null)?.content_text ?? "");
  return (
    <div className="space-y-2 text-sm">
      {text ? (
        <p className="line-clamp-6 whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-muted-foreground">
          {text}
        </p>
      ) : null}
      {tab === "pending" ? (
        <p className="text-xs text-muted-foreground">
          {t("row.articleNote", { language: (item.language ?? "").toUpperCase() })}
        </p>
      ) : null}
    </div>
  );
}
