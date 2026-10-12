"use client";

// ============================================================
// Compliance requests, the reports (/compliance/reports): for the Head of Compliance and the officers (compliance.review or compliance.approve). The cases
// REQUESTED in a date range: counts by type and status, the cases with a regulatory clock against the practice target and the stop, the days to the
// decision and to completion, sign-offs by person, rejections by category, and how old the open cases are; and a CSV for audit. Tables with clear
// numbers, and a thin bar beside a share where it helps: every figure is also written as a number, so nothing depends on seeing the bar.
// No name, phone number or bank detail is on this page or in the file.
// ============================================================

import { ArrowLeft, Download, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { NoAccess } from "@/components/auth/no-access";
import { useCapability } from "@/hooks/use-auth";
import type { ComplianceReport } from "@/lib/compliance/reports";
import { REQUEST_STATUSES } from "@/lib/compliance/types";
import { cn } from "@/lib/utils";

import { getReport, reportCsvUrl } from "./api";
import { errorKey, typeLabel } from "./helpers";
import { Notice } from "./parts";
import { PRESETS, days, percent, presetRange, rangeValid, type Preset } from "./reports-helpers";

const SELECT = "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const INPUT = "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function ReportsScreen() {
  const t = useTranslations("Compliance.reports");
  const tErr = useTranslations("Compliance.errors");
  const canMenu = useCapability("menu.compliance");
  const canReview = useCapability("compliance.review");
  const canApprove = useCapability("compliance.approve");
  const canReports = canReview || canApprove;
  const [preset, setPreset] = useState<Preset>("last90");
  const [from, setFrom] = useState(() => presetRange("last90", new Date()).from);
  const [to, setTo] = useState(() => presetRange("last90", new Date()).to);
  const [type, setType] = useState("");
  const [report, setReport] = useState<ComplianceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const load = useCallback(async (f: string, e: string, ty: string) => {
    const mine = ++seq.current;
    setLoading(true);
    const res = await getReport({ from: f, to: e, type: ty || undefined });
    if (mine !== seq.current) return;
    setLoading(false);
    if (!res.ok) {
      setError(errorKey(res.code));
      return;
    }
    setError(null);
    setReport(res.data);
  }, []);

  const valid = rangeValid(from, to);
  useEffect(() => {
    if (!valid) return;
    // load-on-change fetch whose result sets state
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(from, to, type);
  }, [from, to, type, valid, load]);

  if (!canMenu || !canReports) return <NoAccess />;

  const pick = (p: Preset) => {
    setPreset(p);
    if (p !== "custom") {
      const r = presetRange(p, new Date());
      setFrom(r.from);
      setTo(r.to);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 p-4 md:p-6">
      <Link href="/compliance" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <ArrowLeft className="size-4" aria-hidden />
        {t("back")}
      </Link>
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("intro")}</p>
      </div>

      <form className="grid gap-3 rounded-xl border border-border bg-card p-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={(e) => e.preventDefault()} aria-label={t("filters")}>
        <div>
          <label htmlFor="cmp-rp-preset" className="mb-1 block text-xs font-medium text-muted-foreground">{t("period")}</label>
          <select id="cmp-rp-preset" className={SELECT} value={preset} onChange={(e) => pick(e.target.value as Preset)}>
            {PRESETS.map((p) => (
              <option key={p} value={p}>{t(`presets.${p}`)}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="cmp-rp-from" className="mb-1 block text-xs font-medium text-muted-foreground">{t("from")}</label>
          <input id="cmp-rp-from" type="date" className={INPUT} value={from} max={to || undefined} onChange={(e) => { setPreset("custom"); setFrom(e.target.value); }} />
        </div>
        <div>
          <label htmlFor="cmp-rp-to" className="mb-1 block text-xs font-medium text-muted-foreground">{t("to")}</label>
          <input id="cmp-rp-to" type="date" className={INPUT} value={to} min={from || undefined} onChange={(e) => { setPreset("custom"); setTo(e.target.value); }} />
        </div>
        <div>
          <label htmlFor="cmp-rp-type" className="mb-1 block text-xs font-medium text-muted-foreground">{t("type")}</label>
          <select id="cmp-rp-type" className={SELECT} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">{t("allTypes")}</option>
            {(report?.types ?? []).map((x) => (
              <option key={x.key} value={x.key}>{x.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <a
            href={valid ? reportCsvUrl({ from, to, type: type || undefined }) : undefined}
            download="compliance-requests.csv"
            aria-disabled={!valid}
            className={cn("inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-muted", !valid && "pointer-events-none opacity-50")}
          >
            <Download className="size-4" aria-hidden />
            {t("exportCsv")}
          </a>
        </div>
      </form>
      {!valid ? <Notice tone="danger">{t("badRange")}</Notice> : null}
      {error ? <Notice tone="danger">{tErr(error)}</Notice> : null}
      <p className="text-xs text-muted-foreground">{t("exportNote")}</p>

      {loading && !report ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("loading")}
        </div>
      ) : null}
      {report ? <ReportBody report={report} busy={loading} /> : null}
    </div>
  );
}

// ---- the figures --------------------------------------------------------------------------------------------------------

/** The report's tables. Exported so the markup can be tested with a fixed report. */
export function ReportBody({ report, busy = false }: { report: ComplianceReport; busy?: boolean }) {
  const t = useTranslations("Compliance.reports");
  const ts = useTranslations("Compliance.status");
  const locale = useLocale();
  const typeName = (key: string) => {
    const x = report.types.find((y) => y.key === key);
    return x ? typeLabel({ typeLabel: x.label, typeLabelL10n: x.labelL10n }, locale) : key;
  };
  const person = (id: string) => report.people.find((p) => p.id === id)?.name ?? t("formerMember");
  const clock = report.clock;

  return (
    <div className={cn("space-y-6", busy && "opacity-60")} aria-busy={busy}>
      {report.truncated ? <Notice tone="warn">{t("truncated", { count: 5000 })}</Notice> : null}

      <dl className="grid gap-3 sm:grid-cols-3">
        <Figure label={t("total")} value={report.total} />
        <Figure label={t("open")} value={report.open} />
        <Figure label={t("finished")} value={report.finished} />
      </dl>

      <Table title={t("byType.title")} empty={report.byType.length === 0 ? t("none") : null}>
        <thead>
          <tr>
            <Th>{t("byType.type")}</Th>
            <Th num>{t("byType.total")}</Th>
            {REQUEST_STATUSES.map((s) => (
              <Th key={s} num>{ts(s)}</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.byType.map((r) => (
            <tr key={r.key} className="border-t border-border">
              <th scope="row" className="px-2 py-1.5 text-left font-medium">{typeName(r.key)}</th>
              <Td num strong>{r.total}</Td>
              {REQUEST_STATUSES.map((s) => (
                <Td key={s} num>{r.byStatus[s] ?? 0}</Td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>

      <Table title={t("clock.title")} note={t("clock.note")} empty={clock.considered === 0 ? t("clock.none") : null}>
        <thead>
          <tr>
            <Th>{t("clock.row")}</Th>
            <Th num>{t("count")}</Th>
            <Th num>{t("share")}</Th>
          </tr>
        </thead>
        <tbody>
          {(
            [
              ["withinTarget", clock.withinTarget],
              ["afterTarget", clock.afterTarget],
              ["afterStop", clock.afterStop],
              ["openPastStop", clock.openPastStop],
            ] as const
          ).map(([k, n]) => (
            <tr key={k} className="border-t border-border">
              <th scope="row" className="px-2 py-1.5 text-left font-medium">{t(`clock.${k}`)}</th>
              <Td num strong>{n}</Td>
              <Td num>
                <Share value={percent(n, clock.considered)} danger={k === "afterStop" || k === "openPastStop"} /> {percent(n, clock.considered)}%
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <Table title={t("timing.title")} note={t("timing.note")}>
        <thead>
          <tr>
            <Th>{t("timing.row")}</Th>
            <Th num>{t("count")}</Th>
            <Th num>{t("timing.average")}</Th>
            <Th num>{t("timing.median")}</Th>
          </tr>
        </thead>
        <tbody>
          {(
            [
              ["toDecision", report.timing.toDecision],
              ["toCompletion", report.timing.toCompletion],
            ] as const
          ).map(([k, s]) => (
            <tr key={k} className="border-t border-border">
              <th scope="row" className="px-2 py-1.5 text-left font-medium">{t(`timing.${k}`)}</th>
              <Td num>{s.count}</Td>
              <Td num strong>{days(s.average, locale)}</Td>
              <Td num strong>{days(s.median, locale)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <Table title={t("signoffs.title")} empty={report.signoffs.length === 0 ? t("none") : null}>
        <thead>
          <tr>
            <Th>{t("signoffs.person")}</Th>
            <Th num>{t("signoffs.approved")}</Th>
            <Th num>{t("signoffs.rejected")}</Th>
            <Th num>{t("byType.total")}</Th>
          </tr>
        </thead>
        <tbody>
          {report.signoffs.map((s) => (
            <tr key={s.by} className="border-t border-border">
              <th scope="row" className="px-2 py-1.5 text-left font-medium">{person(s.by)}</th>
              <Td num>{s.approved}</Td>
              <Td num>{s.rejected}</Td>
              <Td num strong>{s.approved + s.rejected}</Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <Table title={t("rejections.title")} empty={report.rejections.length === 0 ? t("none") : null}>
        <thead>
          <tr>
            <Th>{t("rejections.category")}</Th>
            <Th num>{t("count")}</Th>
          </tr>
        </thead>
        <tbody>
          {report.rejections.map((r) => (
            <tr key={r.category} className="border-t border-border">
              <th scope="row" className="px-2 py-1.5 text-left font-medium">{t(`rejections.categories.${r.category}`)}</th>
              <Td num strong>{r.count}</Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <Table title={t("ageing.title")} note={t("ageing.note")}>
        <thead>
          <tr>
            <Th>{t("ageing.age")}</Th>
            <Th num>{t("count")}</Th>
            <Th num>{t("share")}</Th>
          </tr>
        </thead>
        <tbody>
          {report.ageing.map((a) => (
            <tr key={a.bucket} className="border-t border-border">
              <th scope="row" className="px-2 py-1.5 text-left font-medium">{t(`ageing.buckets.${a.bucket}`)}</th>
              <Td num strong>{a.count}</Td>
              <Td num>
                <Share value={percent(a.count, report.open)} danger={a.bucket === "d31_plus"} /> {percent(a.count, report.open)}%
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <p className="text-xs text-muted-foreground">{t("retention")}</p>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function Table({ title, note, empty, children }: { title: string; note?: string; empty?: string | null; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="px-3 pt-3">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
      </div>
      <div className="overflow-x-auto px-1 pb-2 pt-2">
        {empty ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">{empty}</p>
        ) : (
          <table className="w-full min-w-[28rem] text-sm">
            <caption className="sr-only">{title}</caption>
            {children}
          </table>
        )}
      </div>
    </section>
  );
}

const Th = ({ children, num }: { children: ReactNode; num?: boolean }) => (
  <th scope="col" className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", num ? "text-right" : "text-left")}>
    {children}
  </th>
);
const Td = ({ children, num, strong }: { children: ReactNode; num?: boolean; strong?: boolean }) => (
  <td className={cn("px-2 py-1.5 tabular-nums", num && "text-right", strong && "font-semibold")}>{children}</td>
);

/** A thin bar for a share. Decoration only: the number is always written beside it. */
function Share({ value, danger }: { value: number; danger?: boolean }) {
  return (
    <span aria-hidden className="mr-2 inline-block h-1.5 w-16 overflow-hidden rounded-full bg-muted align-middle">
      <span className={cn("block h-full rounded-full", danger ? "bg-destructive" : "bg-primary")} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </span>
  );
}
