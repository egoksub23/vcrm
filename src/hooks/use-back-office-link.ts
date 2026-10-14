"use client";

import { useEffect, useState } from "react";

import { parseBackOfficeBaseUrl } from "@/lib/back-office/link";

// ============================================================
// How this deployment reaches the Vircle Back Office (GET /api/account/back-office-link): the address
// and whether to show it inside the Inbox. Asked once per page load and shared; a failed ask means
// "not configured" (no Back Office action is drawn). Nothing about a contact is sent.
// ============================================================

export interface BackOfficeLinkConfig {
  baseUrl: string | null;
  embed: boolean;
}

const OFF: BackOfficeLinkConfig = { baseUrl: null, embed: false };

let cache: BackOfficeLinkConfig | null = null;
let inflight: Promise<BackOfficeLinkConfig> | null = null;

async function load(): Promise<BackOfficeLinkConfig> {
  if (cache) return cache;
  if (inflight) return inflight;
  const request = (async () => {
    try {
      const res = await fetch("/api/account/back-office-link", { cache: "no-store" });
      if (!res.ok) return OFF;
      const body = (await res.json()) as { baseUrl?: unknown; embed?: unknown };
      // The address is checked again here: whatever came back, only a valid https address switches the feature on.
      const baseUrl = parseBackOfficeBaseUrl(body.baseUrl);
      const config: BackOfficeLinkConfig = { baseUrl, embed: baseUrl !== null && body.embed === true };
      cache = config;
      return config;
    } catch {
      // A network failure is not remembered: the next page load asks again.
      return OFF;
    } finally {
      inflight = null;
    }
  })();
  inflight = request;
  return request;
}

export function useBackOfficeLink(): BackOfficeLinkConfig {
  const [config, setConfig] = useState<BackOfficeLinkConfig>(() => cache ?? OFF);
  useEffect(() => {
    let live = true;
    void load().then((c) => {
      if (live) setConfig(c);
    });
    return () => {
      live = false;
    };
  }, []);
  return config;
}
