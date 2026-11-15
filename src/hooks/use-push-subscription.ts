"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type PushState = "unsupported" | "prompt" | "granted" | "denied" | "loading";

interface UsePushSubscriptionResult {
  pushState: PushState;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from(rawData, (c) => c.charCodeAt(0));
}

/**
 * Manages the browser's Web Push subscription for Sembang notifications.
 *
 * - Checks if push is already granted on mount and registers with the server.
 * - `subscribe()` triggers the browser permission prompt, then saves the
 *   subscription endpoint to /api/sembang/push/subscribe.
 * - `unsubscribe()` removes the browser subscription and deletes it server-side.
 */
export function usePushSubscription(): UsePushSubscriptionResult {
  const [pushState, setPushState] = useState<PushState>("loading");
  const registeredRef = useRef(false);

  // Check on mount whether push is already subscribed.
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushState("unsupported");
      return;
    }

    const check = async () => {
      try {
        const perm = Notification.permission;
        if (perm === "denied") { setPushState("denied"); return; }
        if (perm !== "granted") { setPushState("prompt"); return; }

        const reg = await navigator.serviceWorker.getRegistration("/sw.js");
        if (!reg) { setPushState("prompt"); return; }

        const existing = await reg.pushManager.getSubscription();
        if (existing) {
          setPushState("granted");
          if (!registeredRef.current) {
            registeredRef.current = true;
            await ensureServerSubscription(existing);
          }
        } else {
          setPushState("prompt");
        }
      } catch {
        setPushState("prompt");
      }
    };

    void check();
  }, []);

  const subscribe = useCallback(async () => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    setPushState("loading");
    try {
      // Fetch the VAPID public key
      const keyRes = await fetch("/api/sembang/push/key");
      if (!keyRes.ok) { setPushState("prompt"); return; }
      const { publicKey } = (await keyRes.json()) as { publicKey?: string };
      if (!publicKey) { setPushState("prompt"); return; }

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as ArrayBuffer,
      });

      await ensureServerSubscription(sub);
      setPushState("granted");
    } catch {
      // User dismissed or push failed
      setPushState(Notification.permission === "denied" ? "denied" : "prompt");
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) { setPushState("prompt"); return; }

      await fetch("/api/sembang/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
      setPushState("prompt");
      registeredRef.current = false;
    } catch { /* ignore */ }
  }, []);

  return { pushState, subscribe, unsubscribe };
}

async function ensureServerSubscription(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth   = json.keys?.auth;
  if (!p256dh || !auth) return;

  await fetch("/api/sembang/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint, p256dh, auth }),
  }).catch(() => {});
}
