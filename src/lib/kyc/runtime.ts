// ============================================================
// KYC review: what the routes run against. One small module so tests can replace it (vi.mock) with an environment and a fetch of their own and the
// network is never touched. Server only.
// ============================================================

import { pinnedFetch } from "@/lib/net/safe-fetch";

import type { KycTransport } from "./client";

export interface KycRuntime {
  env: Record<string, string | undefined>;
  transport: KycTransport;
}

/**
 * Both the back end and the image host are reached through pinnedFetch: a connection that re-checks the address it really uses (no private, loopback or
 * link-local address, whatever the name resolves to) and never follows a redirect.
 */
export function kycRuntime(): KycRuntime {
  return {
    env: process.env,
    transport: { api: (url, init) => pinnedFetch(url, init), image: (url, init) => pinnedFetch(url, init) },
  };
}
