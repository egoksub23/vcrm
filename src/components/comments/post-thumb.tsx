"use client";

import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

// ============================================================
// A post's picture. The link stored for it comes from Meta and expires within about a week, so a thumbnail that fails to load is asked for again:
// the server fetches a fresh picture with the workspace's own page token, keeps a copy in our storage and answers with the new link. That is tried
// ONCE per post per page load; a post Meta no longer has (deleted, or the page disconnected) shows the plain tile instead of a broken image.
// ============================================================

const repairs = new Map<string, Promise<string | null>>();

/** One repair per post per page load, shared by every place the same post is drawn (the list, the open thread). */
export function repairPostPicture(postId: string, request: typeof fetch = fetch): Promise<string | null> {
  const known = repairs.get(postId);
  if (known) return known;
  const attempt = request(`/api/comments/posts/${encodeURIComponent(postId)}/refresh-media`, { method: "POST", cache: "no-store", credentials: "same-origin" })
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as { media_url?: unknown } | null;
      return typeof body?.media_url === "string" && body.media_url ? body.media_url : null;
    })
    .catch(() => null);
  repairs.set(postId, attempt);
  return attempt;
}

export function PostThumb({
  postId,
  mediaUrl,
  fallback,
  className,
  lazy,
}: {
  postId: string;
  mediaUrl: string | null;
  /** What to draw when there is no picture, or it cannot be had. */
  fallback: ReactNode;
  /** Size and shape of the picture; the tile the fallback draws has its own. */
  className: string;
  lazy?: boolean;
}) {
  const [shown, setShown] = useState({ source: mediaUrl, src: mediaUrl, failed: false });
  // A different link for the same post (the list was reloaded) starts over; a repaired one is kept until then.
  if (shown.source !== mediaUrl) setShown({ source: mediaUrl, src: mediaUrl, failed: false });

  if (!shown.src || shown.failed) return <>{fallback}</>;

  const onError = () => {
    // The repaired link failing too is final: no second repair loop.
    if (shown.src !== shown.source) {
      setShown((s) => ({ ...s, failed: true }));
      return;
    }
    void repairPostPicture(postId).then((fresh) => {
      setShown((s) => (s.source !== mediaUrl ? s : fresh && fresh !== s.src ? { ...s, src: fresh } : { ...s, failed: true }));
    });
  };

  return (
    // eslint-disable-next-line @next/next/no-img-element -- a post picture from Meta or our own storage; next/image would only add a proxy that cannot reach it
    <img src={shown.src} alt="" className={cn(className)} loading={lazy ? "lazy" : undefined} onError={onError} />
  );
}
