"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, Plus, Share2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-can";
import { CreateShareDialog } from "./create-share-dialog";

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
  contactId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ContactSharesProps {
  contactId: string;
}

export function ContactShares({ contactId }: ContactSharesProps) {
  const canShare = useCapability("share.send");
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/share?contactId=${encodeURIComponent(contactId)}`);
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setShares(data.shares ?? []);
    } catch {
      toast.error("Could not load shares.");
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    load();
  }, [load]);

  async function copyLink(shareId: string) {
    try {
      const res = await fetch(`/api/share/${shareId}`);
      if (!res.ok) return;
      const data = await res.json();
      const url = data.share?.shareUrl ?? "";
      if (!url) return;
      await navigator.clipboard.writeText(url).catch(() => {});
      setCopied(shareId);
      setTimeout(() => setCopied((c) => (c === shareId ? null : c)), 2000);
    } catch {
      // ignore
    }
  }

  async function revokeShare(shareId: string) {
    try {
      await fetch(`/api/share/${shareId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "revoked" }),
      });
      setShares((prev) => prev.map((s) => (s.id === shareId ? { ...s, status: "revoked" as const } : s)));
    } catch {
      toast.error("Could not revoke the share.");
    }
  }

  function handleCreated() {
    setCreateOpen(false);
    void load();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {canShare && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCreateOpen(true)}
            className="border-border text-foreground hover:bg-muted"
          >
            <Plus className="size-3.5" />
            New share
          </Button>
        </div>
      )}

      {shares.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <Share2 className="size-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No shared documents yet.</p>
          {canShare && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCreateOpen(true)}
              className="mt-1 border-border text-foreground hover:bg-muted"
            >
              Share a document
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {shares.map((share) => (
            <div
              key={share.id}
              className={`rounded-lg border p-3 transition-colors ${
                share.status === "revoked"
                  ? "border-border bg-muted/30 opacity-60"
                  : "border-border bg-muted/50"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{share.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{share.fileName}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {share.status === "active" ? (
                    <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[10px] px-1.5 py-0">
                      Active
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                      Revoked
                    </Badge>
                  )}
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {share.viewCount} {share.viewCount === 1 ? "view" : "views"}
                  {share.firstOpenedAt && ` · first opened ${new Date(share.firstOpenedAt).toLocaleDateString()}`}
                </span>
                <span>{new Date(share.createdAt).toLocaleDateString()}</span>
              </div>

              {share.status === "active" && canShare && (
                <div className="mt-2 flex items-center gap-1.5">
                  <button
                    onClick={() => copyLink(share.id)}
                    className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
                  >
                    {copied === share.id ? (
                      <Check className="size-3 text-primary" />
                    ) : (
                      <Copy className="size-3" />
                    )}
                    Copy link
                  </button>
                  <button
                    onClick={() => revokeShare(share.id)}
                    className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-red-400 hover:bg-muted transition-colors cursor-pointer"
                  >
                    Revoke
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <CreateShareDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        contactId={contactId}
        onCreated={handleCreated}
      />
    </div>
  );
}
