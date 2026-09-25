"use client";

// Files, Links & Bookmarks — one panel, three tabs, opened from a
// single header button next to Pinned/Tasks/Members. Self-fetches each
// tab's data on open rather than being piped through channel-thread.tsx's
// already-large state — Files/Links/Bookmarks are new and read-mostly,
// so they own their own fetch here, the same self-contained shape
// threads-panel.tsx/member-directory-dialog.tsx already use for global
// panels, rather than growing channel-thread.tsx's state further for a
// feature that existed before none of it.

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { toast } from "sonner";
import { Bookmark, FileText, Link2, Loader2, Paperclip, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { SembangBookmark, SembangFileItem, SembangLinkItem } from "@/types";

type ResourceTab = "files" | "links" | "bookmarks";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ChannelResourcesPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
}

export function ChannelResourcesPanel({ open, onOpenChange, channelId }: ChannelResourcesPanelProps) {
  const t = useTranslations("Sembang.resourcesPanel");
  const [tab, setTab] = useState<ResourceTab>("files");
  const [files, setFiles] = useState<SembangFileItem[] | null>(null);
  const [links, setLinks] = useState<SembangLinkItem[] | null>(null);
  const [bookmarks, setBookmarks] = useState<SembangBookmark[] | null>(null);
  const [bookmarkUrl, setBookmarkUrl] = useState("");
  const [bookmarkTitle, setBookmarkTitle] = useState("");
  const [addingBookmark, setAddingBookmark] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const fetchFiles = useCallback(async () => {
    if (!channelId) return;
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}/files`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setFiles((data.files as SembangFileItem[]) ?? []);
    } catch {
      // Best-effort — the tab just stays at its last value (or spinner).
    }
  }, [channelId]);

  const fetchLinks = useCallback(async () => {
    if (!channelId) return;
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}/links`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setLinks((data.links as SembangLinkItem[]) ?? []);
    } catch {
      // Best-effort.
    }
  }, [channelId]);

  const fetchBookmarks = useCallback(async () => {
    if (!channelId) return;
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}/bookmarks`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setBookmarks((data.bookmarks as SembangBookmark[]) ?? []);
    } catch {
      // Best-effort.
    }
  }, [channelId]);

  useEffect(() => {
    if (!open) return;
    setFiles(null);
    setLinks(null);
    setBookmarks(null);
    setTab("files");
    void fetchFiles();
    void fetchLinks();
    void fetchBookmarks();
  }, [open, channelId, fetchFiles, fetchLinks, fetchBookmarks]);

  const handleAddBookmark = async () => {
    const url = bookmarkUrl.trim();
    if (!url || addingBookmark) return;
    setAddingBookmark(true);
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}/bookmarks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, title: bookmarkTitle.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t("addBookmarkFailed"));
        return;
      }
      const bookmark = data.bookmark as SembangBookmark;
      setBookmarks((prev) => [bookmark, ...(prev ?? [])]);
      setBookmarkUrl("");
      setBookmarkTitle("");
    } finally {
      setAddingBookmark(false);
    }
  };

  const handleRemoveBookmark = async (id: string) => {
    if (removingId) return;
    setRemovingId(id);
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}/bookmarks/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error || t("removeBookmarkFailed"));
        return;
      }
      setBookmarks((prev) => (prev ?? []).filter((b) => b.id !== id));
    } finally {
      setRemovingId(null);
    }
  };

  const tabs: { key: ResourceTab; label: string; icon: typeof FileText; count: number | null }[] = [
    { key: "files", label: t("filesTab"), icon: Paperclip, count: files?.length ?? null },
    { key: "links", label: t("linksTab"), icon: Link2, count: links?.length ?? null },
    { key: "bookmarks", label: t("bookmarksTab"), icon: Bookmark, count: bookmarks?.length ?? null },
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-[440px]">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
        </SheetHeader>

        <div className="flex shrink-0 gap-1 border-b border-border px-4 pb-2">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              type="button"
              onClick={() => setTab(tb.key)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium",
                tab === tb.key ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted",
              )}
            >
              <tb.icon className="h-3.5 w-3.5" />
              {tb.label}
              {tb.count !== null && tb.count > 0 && (
                <span className="text-[10px] text-muted-foreground">{tb.count}</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto px-4 pt-2 pb-4">
          {tab === "files" &&
            (files === null ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : files.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{t("noFiles")}</p>
            ) : (
              files.map((f) => (
                <a
                  key={f.id}
                  href={f.url || undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-lg border border-border p-2.5 hover:bg-muted/40"
                >
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{f.filename}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {f.authorName} · {formatBytes(f.sizeBytes)} · {format(new Date(f.createdAt), "MMM d, HH:mm")}
                    </p>
                  </div>
                </a>
              ))
            ))}

          {tab === "links" &&
            (links === null ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : links.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{t("noLinks")}</p>
            ) : (
              links.map((l, i) => (
                <a
                  key={`${l.messageId}-${i}`}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-lg border border-border p-2.5 hover:bg-muted/40"
                >
                  <p className="truncate text-sm text-primary">{l.url}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {l.authorName} · {format(new Date(l.createdAt), "MMM d, HH:mm")}
                  </p>
                </a>
              ))
            ))}

          {tab === "bookmarks" && (
            <>
              <div className="space-y-1.5 rounded-lg border border-border p-2.5">
                <Input
                  value={bookmarkUrl}
                  onChange={(e) => setBookmarkUrl(e.target.value)}
                  placeholder={t("bookmarkUrlPlaceholder")}
                  disabled={addingBookmark}
                />
                <div className="flex gap-1.5">
                  <Input
                    value={bookmarkTitle}
                    onChange={(e) => setBookmarkTitle(e.target.value)}
                    placeholder={t("bookmarkTitlePlaceholder")}
                    disabled={addingBookmark}
                    className="flex-1"
                  />
                  <Button
                    size="icon"
                    onClick={handleAddBookmark}
                    disabled={!bookmarkUrl.trim() || addingBookmark}
                    aria-label={t("addBookmark")}
                  >
                    {addingBookmark ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              {bookmarks === null ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                </div>
              ) : bookmarks.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t("noBookmarks")}</p>
              ) : (
                bookmarks.map((b) => (
                  <div key={b.id} className="group flex items-center gap-2 rounded-lg border border-border p-2.5">
                    <Bookmark className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <a
                        href={b.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate text-sm text-primary hover:underline"
                      >
                        {b.title || b.url}
                      </a>
                      <p className="truncate text-[11px] text-muted-foreground">{t("addedBy", { name: b.addedByName })}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("removeBookmark")}
                      onClick={() => handleRemoveBookmark(b.id)}
                      disabled={removingId === b.id}
                      className="opacity-0 group-hover:opacity-100"
                    >
                      {removingId === b.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
