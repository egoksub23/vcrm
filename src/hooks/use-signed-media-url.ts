"use client";

import { useEffect, useState } from "react";

import { cachedSignedUrl, signedMediaUrl } from "@/lib/media/signed-urls";
import { isPrivateMediaUrl } from "@/lib/storage/media-urls";

export type SignedMediaStatus = "idle" | "loading" | "ready" | "error";

/**
 * A URL an element can load for a stored media URL.
 *
 * A file in the private `chat-media` bucket is signed for the signed-in
 * person; anything else (a public-assets file, an external link, an inbound
 * proxy path) is returned unchanged and immediately. Use this for video,
 * audio, documents, thumbnails and downloads. For images in a conversation
 * use `useMediaBlobUrl`, which wraps this and also handles the inbound proxy.
 */
export function useSignedMediaUrl(url: string | null | undefined): {
  src: string | null;
  status: SignedMediaStatus;
} {
  const [resolved, setResolved] = useState<{ url: string; src: string | null } | null>(null);
  const needsSigning = !!url && isPrivateMediaUrl(url);

  useEffect(() => {
    if (!url || !needsSigning) return;
    let cancelled = false;
    signedMediaUrl(url)
      .then((src) => !cancelled && setResolved({ url, src }))
      .catch(() => !cancelled && setResolved({ url, src: null }));
    return () => {
      cancelled = true;
    };
  }, [url, needsSigning]);

  if (!url) return { src: null, status: "idle" };
  if (!needsSigning) return { src: url, status: "ready" };

  const cached = cachedSignedUrl(url);
  if (cached) return { src: cached, status: "ready" };
  if (resolved?.url === url) {
    return resolved.src ? { src: resolved.src, status: "ready" } : { src: null, status: "error" };
  }
  return { src: null, status: "loading" };
}
