"use client";

// ============================================================
// ShareAnalyticsPanel — slide-in drawer showing per-share
// analytics: view count, unique viewers, avg dwell, page chart,
// and the viewer log. Also exposes the download and revoke toggles.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Copy, Check, Download, ExternalLink, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface ViewRow {
  id: string;
  viewerEmail: string | null;
  viewedAt: string;
  durationMs: number | null;
  pageDwells: number[] | null;
}

interface ShareDetail {
  id: string;
  title: string;
  fileName: string;
  fileSize: number;
  status: "active" | "revoked";
  gateType: string;
  downloadEnabled: boolean;
  viewCount: number;
  firstOpenedAt: string | null;
  createdAt: string;
  shareUrl: string; // nested in share object from API
}

interface ShareAnalyticsPanelProps {
  shareId: string;
  onClose: () => void;
  onRevoked: () => void;
  onDownloadToggled: (enabled: boolean) => void;
}

function fmtDuration(ms: number | null) {
  if (!ms || ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ShareAnalyticsPanel({ shareId, onClose, onRevoked, onDownloadToggled }: ShareAnalyticsPanelProps) {
  const [share, setShare] = useState<ShareDetail | null>(null);
  const [views, setViews] = useState<ViewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [togglingDownload, setTogglingDownload] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/share/${shareId}`);
      if (!res.ok) { toast.error("Could not load analytics."); return; }
      const d = await res.json();
      setShare(d.share ?? null);
      setViews((d.views as ViewRow[]) ?? []);
    } catch {
      toast.error("Could not load analytics.");
    } finally {
      setLoading(false);
    }
  }, [shareId]);

  useEffect(() => { void load(); }, [load]);

  async function copyLink() {
    if (!share?.shareUrl) return;
    try { await navigator.clipboard.writeText(share.shareUrl); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function revoke() {
    if (!share) return;
    setRevoking(true);
    try {
      const res = await fetch(`/api/share/${shareId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "revoked" }),
      });
      if (!res.ok) { toast.error("Could not revoke the share."); return; }
      setShare((s) => s ? { ...s, status: "revoked" } : s);
      onRevoked();
    } catch {
      toast.error("Could not revoke the share.");
    } finally {
      setRevoking(false);
    }
  }

  async function toggleDownload() {
    if (!share) return;
    const next = !share.downloadEnabled;
    setTogglingDownload(true);
    try {
      const res = await fetch(`/api/share/${shareId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ downloadEnabled: next }),
      });
      if (!res.ok) { toast.error("Could not update the share."); return; }
      setShare((s) => s ? { ...s, downloadEnabled: next } : s);
      onDownloadToggled(next);
    } catch {
      toast.error("Could not update the share.");
    } finally {
      setTogglingDownload(false);
    }
  }

  // Aggregate page dwells across all views
  const pageDwellData = (() => {
    if (!views.length) return [];
    const totals: number[] = [];
    for (const v of views) {
      if (!v.pageDwells) continue;
      v.pageDwells.forEach((ms, i) => { totals[i] = (totals[i] ?? 0) + ms; });
    }
    return totals.map((ms, i) => ({ page: `P${i + 1}`, ms: Math.round(ms / 1000) })).filter((d) => d.ms > 0);
  })();

  // Stats
  const uniqueEmails = new Set(views.map((v) => v.viewerEmail).filter(Boolean)).size;
  const totalDuration = views.reduce((s, v) => s + (v.durationMs ?? 0), 0);
  const avgDuration = views.length ? totalDuration / views.length : null;

  return (
    <div
      className="fixed inset-y-0 right-0 z-40 w-full max-w-md border-l border-border bg-background shadow-xl flex flex-col"
      role="dialog"
      aria-modal="true"
    >
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3 shrink-0">
        <div className="flex-1 min-w-0">
          {loading || !share ? (
            <div className="h-4 w-40 rounded bg-muted animate-pulse" />
          ) : (
            <>
              <p className="text-sm font-semibold text-foreground truncate">{share.title}</p>
              <p className="text-xs text-muted-foreground truncate">{share.fileName} · {fmtBytes(share.fileSize)}</p>
            </>
          )}
        </div>
        <button onClick={onClose} className="rounded p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
          <X className="size-4" />
        </button>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : !share ? null : (
        <div className="flex-1 overflow-y-auto p-4 space-y-5">

          {/* Status + actions */}
          <div className="flex items-center gap-2 flex-wrap">
            {share.status === "active" ? (
              <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-xs">Active</Badge>
            ) : (
              <Badge variant="outline" className="text-xs text-muted-foreground">Revoked</Badge>
            )}
            {share.gateType !== "none" && (
              <Badge variant="outline" className="text-xs capitalize">{share.gateType} gate</Badge>
            )}
            <div className="flex items-center gap-1.5 ml-auto">
              {share.status === "active" && (
                <>
                  <Button size="sm" variant="outline" onClick={copyLink} className="h-7 gap-1.5 text-xs">
                    {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
                    Copy link
                  </Button>
                  <a
                    href={share.shareUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    <ExternalLink className="size-3" />
                    Open
                  </a>
                </>
              )}
            </div>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Total views", value: String(share.viewCount) },
              { label: "Unique emails", value: uniqueEmails > 0 ? String(uniqueEmails) : "—" },
              { label: "Avg. time", value: avgDuration !== null ? fmtDuration(avgDuration) : "—" },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-lg border border-border bg-muted/40 p-3 text-center">
                <p className="text-lg font-bold text-foreground">{value}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{label}</p>
              </div>
            ))}
          </div>

          {/* Page dwell chart */}
          {pageDwellData.length > 1 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Time per page (seconds)</p>
              <div className="h-40 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={pageDwellData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <XAxis dataKey="page" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                    <Tooltip
                      contentStyle={{ fontSize: 12, borderRadius: 6 }}
                      formatter={(v: unknown) => [`${v as number}s`, "Time"]}
                    />
                    <Bar dataKey="ms" radius={[3, 3, 0, 0]}>
                      {pageDwellData.map((_, i) => (
                        <Cell key={i} fill="hsl(var(--primary))" fillOpacity={0.7 + (i % 2) * 0.3} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Viewer log */}
          {views.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Recent views</p>
              <div className="space-y-1.5">
                {views.slice(0, 20).map((v) => (
                  <div key={v.id} className="flex items-start justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-foreground truncate">{v.viewerEmail ?? "Anonymous"}</p>
                      <p className="text-[11px] text-muted-foreground">{new Date(v.viewedAt).toLocaleString()}</p>
                    </div>
                    {v.durationMs && v.durationMs > 0 ? (
                      <span className="text-[11px] text-muted-foreground shrink-0">{fmtDuration(v.durationMs)}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Controls */}
          {share.status === "active" && (
            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Controls</p>
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Download className={`size-4 ${share.downloadEnabled ? "text-muted-foreground" : "text-muted-foreground/40"}`} />
                  <div>
                    <p className="text-xs font-medium text-foreground">Download</p>
                    <p className="text-[11px] text-muted-foreground">{share.downloadEnabled ? "Viewers can download" : "Download disabled"}</p>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={toggleDownload}
                  disabled={togglingDownload}
                  className="h-7 text-xs"
                >
                  {togglingDownload && <Loader2 className="size-3 animate-spin" />}
                  {share.downloadEnabled ? "Disable" : "Enable"}
                </Button>
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={revoke}
                disabled={revoking}
                className="w-full text-xs text-red-500 border-red-200 hover:bg-red-50 dark:hover:bg-red-950 dark:border-red-900 dark:text-red-400"
              >
                {revoking && <Loader2 className="size-3 animate-spin" />}
                Revoke link
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
