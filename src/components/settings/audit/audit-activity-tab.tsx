"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/hooks/use-auth";
import { buildAuditParams, resolveRange, type RangePreset } from "@/lib/audit/client";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, EMPTY_AUDIT_FILTERS, type AuditFilters } from "@/lib/audit/types";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

import {
  AuditActionBadge,
  AuditActor,
  AuditEntity,
  AuditSummary,
  AuditTime,
} from "./audit-parts";
import { useAuditLog } from "./use-audit-log";

const PRESETS: readonly RangePreset[] = ["24h", "7d", "30d", "all", "custom"];
const SEARCH_DEBOUNCE_MS = 300;

const selectClass =
  "h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

interface Member {
  id: string;
  name: string;
}

/** Settings > Audit log > Activity: filters, the table, Load more, Export CSV. */
export function AuditActivityTab() {
  const t = useTranslations("Settings.audit");
  const tAudit = useTranslations("Audit");
  const { accountId, loading: authLoading } = useAuth();

  const [members, setMembers] = useState<Member[]>([]);
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [preset, setPreset] = useState<RangePreset>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [exporting, setExporting] = useState(false);

  // People for the "Person" filter.
  useEffect(() => {
    if (authLoading || !accountId) return;
    let cancelled = false;
    createClient()
      .from("profiles")
      .select("user_id, full_name, email")
      .then(({ data }) => {
        if (cancelled) return;
        setMembers(
          ((data ?? []) as { user_id: string; full_name: string | null; email: string | null }[])
            .map((p) => ({ id: p.user_id, name: p.full_name?.trim() || p.email || "" }))
            .filter((m) => m.name)
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [authLoading, accountId]);

  // Text search waits for a pause in typing.
  useEffect(() => {
    const id = window.setTimeout(() => setQ(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [search]);

  // "24h / 7d / 30d" are relative to when the filters last changed, so a
  // tab left open does not silently keep an old window.
  const filters: AuditFilters = useMemo(() => {
    const range = resolveRange(preset, { from: customFrom, to: customTo });
    return {
      ...EMPTY_AUDIT_FILTERS,
      actor: actor || null,
      action: (action || null) as AuditFilters["action"],
      entityType: entityType || null,
      from: range.from,
      to: range.to,
      q: q || null,
    };
  }, [actor, action, entityType, preset, customFrom, customTo, q]);

  const { entries, status, hasMore, loadingMore, loadMore, reload } = useAuditLog(filters);

  const anyFilter = !!(actor || action || entityType || q || preset !== "30d");
  function clearFilters() {
    setActor("");
    setAction("");
    setEntityType("");
    setPreset("30d");
    setCustomFrom("");
    setCustomTo("");
    setSearch("");
    setQ("");
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const res = await fetch(`/api/account/audit/export?${buildAuditParams(filters).toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t("exportFailed"));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={selectClass}
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          aria-label={t("filters.person")}
        >
          <option value="">{t("filters.anyone")}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          <option value="system">{tAudit("actorKinds.system")}</option>
          <option value="automation">{tAudit("actorKinds.automation")}</option>
          <option value="api">{tAudit("actorKinds.api")}</option>
        </select>

        <select
          className={selectClass}
          value={action}
          onChange={(e) => setAction(e.target.value)}
          aria-label={t("filters.action")}
        >
          <option value="">{t("filters.anyAction")}</option>
          {AUDIT_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {tAudit(`actions.${a}`)}
            </option>
          ))}
        </select>

        <select
          className={selectClass}
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          aria-label={t("filters.type")}
        >
          <option value="">{t("filters.anyType")}</option>
          {AUDIT_ENTITY_TYPES.map((e) => (
            <option key={e} value={e}>
              {tAudit(`entities.${e}`)}
            </option>
          ))}
        </select>

        <div className="relative min-w-[180px] max-w-xs flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("filters.search")}
            aria-label={t("filters.search")}
            className="h-9 pl-8"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={t("filters.range")} className="inline-flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <Button
              key={p}
              type="button"
              size="sm"
              variant={preset === p ? "default" : "outline"}
              aria-pressed={preset === p}
              onClick={() => setPreset(p)}
            >
              {t(`filters.range_${p}`)}
            </Button>
          ))}
        </div>
        {preset === "custom" ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {t("filters.from")}
              <Input
                type="date"
                value={customFrom}
                max={customTo || undefined}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="h-9 w-40"
              />
            </label>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {t("filters.to")}
              <Input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={(e) => setCustomTo(e.target.value)}
                className="h-9 w-40"
              />
            </label>
          </div>
        ) : null}
        {anyFilter ? (
          <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
            <X className="size-4" />
            {t("filters.clear")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={exportCsv}
          disabled={exporting || status !== "ready" || entries.length === 0}
          title={t("exportHint")}
        >
          {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {t("export")}
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {status === "loading" ? (
          <div className="flex items-center justify-center py-12" role="status">
            <Loader2 className="size-6 animate-spin text-primary" />
            <span className="sr-only">{t("loading")}</span>
          </div>
        ) : status === "error" ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center" role="alert">
            <p className="text-sm text-destructive">{t("loadFailed")}</p>
            <Button variant="outline" size="sm" onClick={reload}>
              {t("retry")}
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {anyFilter ? t("emptyFiltered") : t("empty")}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.time")}</TableHead>
                <TableHead>{t("columns.who")}</TableHead>
                <TableHead>{t("columns.action")}</TableHead>
                <TableHead>{t("columns.item")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("columns.details")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="align-top">
                    <AuditTime iso={entry.createdAt} />
                  </TableCell>
                  <TableCell className="max-w-[12rem] align-top">
                    <AuditActor actor={entry.actor} />
                  </TableCell>
                  <TableCell className="align-top">
                    <AuditActionBadge action={entry.action} />
                  </TableCell>
                  <TableCell className="align-top">
                    <AuditEntity entry={entry} />
                    {/* Details sit under the item on narrow screens. */}
                    <AuditSummary
                      action={entry.action}
                      summary={entry.summary}
                      className={cn("mt-1 block md:hidden")}
                    />
                  </TableCell>
                  <TableCell className="hidden max-w-sm align-top md:table-cell">
                    <AuditSummary action={entry.action} summary={entry.summary} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {status === "ready" && hasMore ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
