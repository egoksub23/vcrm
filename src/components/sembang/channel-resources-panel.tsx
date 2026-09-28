"use client";

// Files, Links & Bookmarks — now three separate top-level channel tabs
// (channel-thread.tsx's tab bar), not a single "Files & links" tab with
// its own nested sub-tab row. One component still backs all three
// (`section` picks which list renders) so switching between them doesn't
// re-fetch — channel-thread.tsx keeps this component mounted across all
// three tab keys, only the `section` prop changes.
//
// Self-fetches all three lists together on mount (i.e. whenever any of
// the three tabs is first activated) rather than being piped through
// channel-thread.tsx's already-large state — Files/Links/Bookmarks are
// read-mostly, so they own their own fetch here, the same self-contained
// shape thread-panel.tsx/member-directory-dialog.tsx already use for
// global panels, rather than growing channel-thread.tsx's state further
// for a feature that existed before none of it.

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { toast } from "sonner";
import { Bookmark, Download, FileText, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LinkPreviewCard } from "./link-preview-card";
import type { SembangBookmark, SembangFileItem, SembangLinkItem } from "@/types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ChannelResourcesTabBodyProps {
  channelId: string;
  section: "files" | "links" | "bookmarks";
}

export function ChannelResourcesTabBody({ channelId, section }: ChannelResourcesTabBodyProps) {
  const t = useTranslations("Sembang.resourcesPanel");
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
    setFiles(null);
    setLinks(null);
    setBookmarks(null);
    void fetchFiles();
    void fetchLinks();
    void fetchBookmarks();
  }, [channelId, fetchFiles, fetchLinks, fetchBookmarks]);

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

  if (section === "files") {
    return (
      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3 sm:px-4">
        {files === null ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : files.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("noFiles")}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {files.map((f) =>
              f.mimeType?.startsWith("image/") ? (
                <div key={f.id} className="group relative overflow-hidden rounded-lg border border-border">
                  <a href={f.url || undefined} target="_blank" rel="noreferrer" className="block">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a signed Storage URL, not an optimizable static asset */}
                    <img src={f.url} alt={f.filename} className="h-32 w-full object-cover" />
                  </a>
                  <a
                    href={f.url || undefined}
                    download={f.filename}
                    aria-label={t("download")}
                    title={t("download")}
                    className="absolute top-1.5 right-1.5 rounded-md bg-background/80 p-1 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 hover:bg-background"
                  >
                    <Download className="h-3.5 w-3.5 text-foreground" />
                  </a>
                  <div className="bg-background/80 px-2 py-1 backdrop-blur-sm">
                    <p className="truncate text-[11px] text-foreground">{f.filename}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {f.authorName} · {formatBytes(f.sizeBytes)}
                    </p>
                  </div>
                </div>
              ) : (
                <a
                  key={f.id}
                  href={f.url || undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="col-span-2 flex items-center gap-2 rounded-lg border border-border p-2.5 hover:bg-muted/40 sm:col-span-3"
                >
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{f.filename}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {f.authorName} · {formatBytes(f.sizeBytes)} · {format(new Date(f.createdAt), "MMM d, HH:mm")}
                    </p>
                  </div>
                </a>
              ),
            )}
          </div>
        )}
      </div>
    );
  }

  if (section === "links") {
    return (
      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3 sm:px-4">
        {links === null ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : links.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("noLinks")}</p>
        ) : (
          links.map((l, i) =>
            l.preview ? (
              <div key={`${l.messageId}-${i}`} className="rounded-lg border border-border p-2.5">
                <LinkPreviewCard
                  url={l.url}
                  title={l.preview.title}
                  description={l.preview.description}
                  imageUrl={l.preview.imageUrl}
                  domain={l.preview.domain}
                  className="max-w-none border-none bg-transparent p-0 hover:bg-transparent"
                />
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {l.authorName} · {format(new Date(l.createdAt), "MMM d, HH:mm")}
                </p>
              </div>
            ) : (
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
            ),
          )
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3 sm:px-4">
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
          <div key={b.id} className="group rounded-lg border border-border p-2.5">
            <div className="flex items-start gap-2">
              {b.title || b.description || b.imageUrl ? (
                <LinkPreviewCard
                  url={b.url}
                  title={b.title}
                  description={b.description}
                  imageUrl={b.imageUrl}
                  domain={b.domain}
                  className="max-w-none flex-1 border-none bg-transparent p-0 hover:bg-transparent"
                />
              ) : (
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  <Bookmark className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <a href={b.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-sm text-primary hover:underline">
                    {b.url}
                  </a>
                </div>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("removeBookmark")}
                onClick={() => handleRemoveBookmark(b.id)}
                disabled={removingId === b.id}
                className="shrink-0 opacity-0 group-hover:opacity-100"
              >
                {removingId === b.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">{t("addedBy", { name: b.addedByName })}</p>
          </div>
        ))
      )}
    </div>
  );
}
