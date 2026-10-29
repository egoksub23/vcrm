"use client";

// ============================================================
// /share — Secure Share dashboard: list all shares, view
// analytics, create new ones, revoke or toggle download.
// Gated by menu.share; the actual create/manage actions need
// share.send (checked per-action by the API).
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Link2, Loader2, Plus, Search, Share2 } from "lucide-react";
import { toast } from "sonner";

import { NoAccess } from "@/components/auth/no-access";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCapability } from "@/hooks/use-can";
import { CreateShareDialog } from "@/components/share/create-share-dialog";
import { ShareAnalyticsPanel } from "@/components/share/share-analytics-panel";

interface ShareRow {
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
}

export default function SharePage() {
  const canView = useCapability("menu.share");
  const canSend = useCapability("share.send");
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [filtered, setFiltered] = useState<ShareRow[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [analyticsId, setAnalyticsId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/share");
      if (!res.ok) { toast.error("Could not load shares."); return; }
      const d = await res.json();
      const rows = (d.shares ?? []) as ShareRow[];
      setShares(rows);
      setFiltered(rows);
    } catch {
      toast.error("Could not load shares.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (canView) void load(); }, [canView, load]);

  useEffect(() => {
    const q = search.toLowerCase();
    setFiltered(q ? shares.filter((s) => s.title.toLowerCase().includes(q) || s.fileName.toLowerCase().includes(q)) : shares);
  }, [search, shares]);

  async function copyLink(shareId: string) {
    try {
      const res = await fetch(`/api/share/${shareId}`);
      if (!res.ok) return;
      const d = await res.json();
      const url = d.share?.shareUrl ?? "";
      if (!url) return;
      await navigator.clipboard.writeText(url).catch(() => {});
      setCopied(shareId);
      setTimeout(() => setCopied((c) => (c === shareId ? null : c)), 2000);
    } catch {
      // ignore
    }
  }

  if (!canView) return <NoAccess />;

  return (
    <div className="mx-auto max-w-[1200px]">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link2 className="size-5 text-muted-foreground" aria-hidden />
          <h1 className="text-xl font-semibold text-foreground">Secure Share</h1>
        </div>
        {canSend && (
          <Button size="lg" onClick={() => setCreateOpen(true)}>
            <Plus />
            New share
          </Button>
        )}
      </div>

      {/* Search */}
      {shares.length > 5 && (
        <div className="relative mb-4 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search shares…"
            className="pl-9 h-9"
          />
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Share2 className="size-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {search ? "No shares match your search." : "No shared documents yet."}
          </p>
          {canSend && !search && (
            <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
              Share your first document
            </Button>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Document</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground hidden sm:table-cell">Access</th>
                <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Views</th>
                <th className="px-4 py-2.5 text-right font-medium text-muted-foreground hidden md:table-cell">Created</th>
                <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((share, i) => (
                <tr
                  key={share.id}
                  className={`border-b border-border last:border-0 hover:bg-muted/30 cursor-pointer transition-colors ${share.status === "revoked" ? "opacity-50" : ""} ${i % 2 === 0 ? "" : "bg-muted/10"}`}
                  onClick={() => setAnalyticsId(share.id)}
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-foreground truncate max-w-[200px] md:max-w-[300px]">{share.title}</p>
                    <p className="text-xs text-muted-foreground truncate max-w-[200px] md:max-w-[300px]">{share.fileName}</p>
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <span className="capitalize text-xs text-muted-foreground">{share.gateType === "none" ? "Open" : share.gateType}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="font-medium">{share.viewCount}</span>
                    {share.firstOpenedAt && (
                      <p className="text-[11px] text-muted-foreground">first {new Date(share.firstOpenedAt).toLocaleDateString()}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-muted-foreground hidden md:table-cell">
                    {new Date(share.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {share.status === "active" ? (
                      <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[10px]">Active</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">Revoked</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    {share.status === "active" && canSend && (
                      <button
                        onClick={(e) => { e.stopPropagation(); void copyLink(share.id); }}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      >
                        {copied === share.id ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
                        Copy
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Analytics panel */}
      {analyticsId && (
        <>
          <div className="fixed inset-0 z-30 bg-black/20" onClick={() => setAnalyticsId(null)} />
          <ShareAnalyticsPanel
            shareId={analyticsId}
            onClose={() => setAnalyticsId(null)}
            onRevoked={() => {
              setShares((prev) => prev.map((s) => s.id === analyticsId ? { ...s, status: "revoked" as const } : s));
              setAnalyticsId(null);
            }}
            onDownloadToggled={(enabled) => {
              setShares((prev) => prev.map((s) => s.id === analyticsId ? { ...s, downloadEnabled: enabled } : s));
            }}
          />
        </>
      )}

      <CreateShareDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => { setCreateOpen(false); void load(); }}
      />
    </div>
  );
}
