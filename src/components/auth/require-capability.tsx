"use client";

import type { ReactNode } from "react";

import { useCapability } from "@/hooks/use-auth";
import type { CapabilityKey } from "@/lib/auth/capabilities";

interface RequireCapabilityProps {
  /** The capability that unlocks `children`. */
  cap: CapabilityKey | (string & {});
  /** Rendered while capabilities load, on failure, and when the caller
   *  lacks `cap`. Defaults to nothing. */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * `<RequireCapability cap="tags.manage">...</RequireCapability>`:
 * conditional render for UI gated by a capability. Like `RequireRole`
 * it fails closed: nothing is shown until the capability is known to
 * be held. It only hides UI; the API and database still enforce it.
 */
export function RequireCapability({
  cap,
  fallback = null,
  children,
}: RequireCapabilityProps) {
  const allowed = useCapability(cap);
  return <>{allowed ? children : fallback}</>;
}
