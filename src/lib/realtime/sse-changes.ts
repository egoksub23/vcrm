// Compatibility shim — re-exports for hooks that previously imported from
// scoped-changes.ts. New hooks should import directly from use-account-sse.
export { useAccountSse, type SsePayload, type SseEventType } from "@/hooks/use-account-sse";

export type ChangePayload = import("@/hooks/use-account-sse").SsePayload;

/** Filter string for readability — no longer sent to any server, just kept for
 *  documentation purposes in hook code that migrated from scoped-changes. */
export const eq = (column: string, value: string) => `${column}=eq.${value}`;
