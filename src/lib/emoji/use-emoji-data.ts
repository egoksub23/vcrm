"use client";

import { useEffect, useState } from "react";

import { getLoadedEmojiData, loadEmojiData } from "./data";
import type { EmojiData } from "./types";

/**
 * The emoji data, loaded on first use. `enabled` starts the (lazy, code-split)
 * load; until then, and while it is in flight, `data` is null. `failed` is set
 * if the chunk could not be fetched.
 */
export function useEmojiData(enabled = true): { data: EmojiData | null; failed: boolean } {
  const [data, setData] = useState<EmojiData | null>(getLoadedEmojiData);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled || data) return;
    let cancelled = false;
    loadEmojiData().then(
      (d) => {
        if (!cancelled) setData(d);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, data]);

  return { data, failed };
}
