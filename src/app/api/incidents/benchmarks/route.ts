// GET /api/incidents/benchmarks — anonymous cross-school metrics.
// Returns this school's stats alongside aggregate stats across all Halo schools, fully anonymised (no school names, no counts per school).
// Requires incidents.manage.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { createAdminPgDb } from "@/lib/postgres/db";

export interface BenchmarkData {
  /** This school's stats. */
  mine: {
    total: number;
    closedLast30Days: number;
    medianDaysToClose: number | null;
    topCategory: string | null;
    topCategoryCount: number;
    byStatus: { status: string; count: number }[];
  };
  /** Anonymous aggregate across all Halo schools with >= 5 incidents in the same window. */
  network: {
    schoolCount: number;
    p25DaysToClose: number | null;
    medianDaysToClose: number | null;
    p75DaysToClose: number | null;
    typicalMonthlyRate: number | null;
  };
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.manage");
    const db = createAdminPgDb();
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString();
    const thirtyAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();

    // This school's data.
    const { data: myRows } = await db
      .from("incidents")
      .select("id, incident_type, status, created_at, closed_at")
      .eq("account_id", ctx.accountId)
      .eq("is_test", false)
      .gte("created_at", since);
    const rows = (myRows ?? []) as { id: string; incident_type: string; status: string; created_at: string; closed_at: string | null }[];

    const closedLast30 = rows.filter((r) => r.closed_at && r.closed_at >= thirtyAgo);
    const closeTimes = rows
      .filter((r) => r.closed_at)
      .map((r) => Math.round((new Date(r.closed_at!).getTime() - new Date(r.created_at).getTime()) / 86_400_000))
      .filter((d) => d >= 0)
      .sort((a, b) => a - b);

    const typeCounts = new Map<string, number>();
    for (const r of rows) typeCounts.set(r.incident_type, (typeCounts.get(r.incident_type) ?? 0) + 1);
    let topCategory: string | null = null;
    let topCategoryCount = 0;
    for (const [cat, cnt] of typeCounts) {
      if (cnt > topCategoryCount) { topCategory = cat; topCategoryCount = cnt; }
    }

    const statusCounts = new Map<string, number>();
    for (const r of rows) statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
    const byStatus = [...statusCounts.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);

    // Network aggregate: all accounts with incidents.manage enabled and >= 5 incidents in the window.
    // We only compute close times for each account to stay fully anonymous.
    const { data: netRows } = await db
      .from("incidents")
      .select("account_id, created_at, closed_at")
      .eq("is_test", false)
      .gte("created_at", since)
      .not("closed_at", "is", null);

    const perAccount = new Map<string, number[]>();
    for (const r of (netRows ?? []) as { account_id: string; created_at: string; closed_at: string | null }[]) {
      if (!r.closed_at) continue;
      const days = Math.round((new Date(r.closed_at).getTime() - new Date(r.created_at).getTime()) / 86_400_000);
      if (days < 0) continue;
      if (!perAccount.has(r.account_id)) perAccount.set(r.account_id, []);
      perAccount.get(r.account_id)!.push(days);
    }

    // Only schools with at least 5 closed incidents qualify for the benchmark.
    const qualifiedSchools = [...perAccount.entries()].filter(([, times]) => times.length >= 5);
    const schoolCount = qualifiedSchools.length;
    // Per-school medians → aggregate percentiles (school-level, not incident-level, to avoid large-school dominance).
    const schoolMedians = qualifiedSchools.map(([, times]) => median(times.sort((a, b) => a - b))!).sort((a, b) => a - b);

    // Monthly rate: average incidents per month per qualified school.
    const { data: totalPerAcct } = await db
      .from("incidents")
      .select("account_id", { count: "estimated" })
      .eq("is_test", false)
      .gte("created_at", since);
    // Count rows per account for rate.
    const rateByAcct = new Map<string, number>();
    for (const r of (netRows ?? []) as { account_id: string }[]) {
      rateByAcct.set(r.account_id, (rateByAcct.get(r.account_id) ?? 0) + 1);
    }
    // Also count all incidents (not just closed).
    const { data: allRateRows } = await db
      .from("incidents")
      .select("account_id")
      .eq("is_test", false)
      .gte("created_at", since);
    const allByAcct = new Map<string, number>();
    for (const r of (allRateRows ?? []) as { account_id: string }[]) {
      allByAcct.set(r.account_id, (allByAcct.get(r.account_id) ?? 0) + 1);
    }
    const qualifiedRates = qualifiedSchools
      .map(([acct]) => (allByAcct.get(acct) ?? 0) / 12)
      .filter((r) => r > 0)
      .sort((a, b) => a - b);
    const typicalMonthlyRate = qualifiedRates.length > 0 ? Math.round(median(qualifiedRates)! * 10) / 10 : null;

    return NextResponse.json({
      mine: {
        total: rows.length,
        closedLast30Days: closedLast30.length,
        medianDaysToClose: median(closeTimes),
        topCategory,
        topCategoryCount,
        byStatus,
      },
      network: {
        schoolCount,
        p25DaysToClose: percentile(schoolMedians, 25),
        medianDaysToClose: median(schoolMedians),
        p75DaysToClose: percentile(schoolMedians, 75),
        typicalMonthlyRate,
      },
    } satisfies BenchmarkData);
  } catch (err) {
    return toErrorResponse(err);
  }
}
