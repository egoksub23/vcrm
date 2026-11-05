"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useAccountSse, type SsePayload } from "@/hooks/use-account-sse";
import type { Message } from "@/types";
import {
  DEFAULT_NOTIFICATION_LABELS,
  buildNotificationContent,
  conversationHref,
  getNotificationPermission,
  pickContactDisplayName,
  readBrowserNotifyPref,
  shouldNotifyForMessage,
  subscribeBrowserNotifyPref,
  viewedConversationFromLocation,
  type NotificationLabels,
} from "@/lib/notifications/browser-notify";

const serverSnapshot = () => false;

/**
 * The device-scoped "browser notifications" opt-in, kept in sync with
 * localStorage across this tab (settings toggle) and other tabs.
 */
export function useBrowserNotifyPref(): boolean {
  return useSyncExternalStore(
    subscribeBrowserNotifyPref,
    readBrowserNotifyPref,
    serverSnapshot,
  );
}

/**
 * Desktop notifications for new inbound customer messages. Mount ONCE
 * per signed-in dashboard tab (the dashboard shell does this via
 * <BrowserNotificationsListener />) so alerts fire on any page.
 *
 * Listens for realtime INSERTs on `messages` — RLS scopes the stream to
 * the caller's account, same as useTotalUnread / useRealtime. Only
 * live events are considered: there is no initial fetch, so an existing
 * backlog never produces a burst of alerts on page load.
 *
 * Own channel name so it coexists with the inbox page's subscription
 * and the sidebar's unread counters.
 *
 * Fires only while a dashboard tab is open — there is no service worker
 * or Web Push here, so a closed browser stays quiet.
 */
export function useBrowserNotifications(): void {
  const enabled = useBrowserNotifyPref();
  const router = useRouter();
  const t = useTranslations("Settings.browserNotifications.labels");

  // Translated labels, read inside the async Realtime callback. Kept in
  // a ref (assigned in an effect, not during render) so a locale change
  // doesn't tear down and re-open the channel.
  const labelsRef = useRef<NotificationLabels>(DEFAULT_NOTIFICATION_LABELS);
  useEffect(() => {
    labelsRef.current = {
      fallbackTitle: t("fallbackTitle"),
      image: t("image"),
      audio: t("audio"),
      video: t("video"),
      document: t("document"),
      location: t("location"),
      template: t("template"),
    };
  });

  const { accountId } = useAuth();

  // Message ids already handled, for replay dedupe. Survives re-renders,
  // pruned by shouldNotifyForMessage.
  const seenRef = useRef<Map<string, number>>(new Map());
  const cancelledRef = useRef(false);
  const routerRef = useRef(router);
  useEffect(() => { routerRef.current = router; });

  // Track mount/unmount so the async notify callback doesn't fire after teardown.
  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, [enabled, accountId]);

  const active = enabled && !!accountId;

  useAccountSse(
    "messages",
    active
      ? (payload: SsePayload) => {
          if (payload.eventType !== "INSERT") return;
          if (getNotificationPermission() !== "granted") return;
          const msg = payload.new as Message;
          const shouldNotify = shouldNotifyForMessage(msg, {
            documentVisible: document.visibilityState === "visible",
            viewingConversationId: viewedConversationFromLocation(
              window.location.pathname,
              window.location.search,
            ),
            seen: seenRef.current,
          });
          if (!shouldNotify) return;

          void (async () => {
            const { data } = await createClient()
              .from("conversations")
              .select("contact:contacts(name, wa_username, phone, wallet_id)")
              .eq("id", msg.conversation_id)
              .maybeSingle();
            if (cancelledRef.current) return;

            const contact = (data as {
              contact?: {
                name?: string | null;
                wa_username?: string | null;
                phone?: string | null;
                wallet_id?: string | null;
              } | null;
            } | null)?.contact;
            const { title, body } = buildNotificationContent(
              msg,
              pickContactDisplayName(contact),
              labelsRef.current,
            );

            try {
              const notification = new Notification(title, {
                body,
                tag: msg.conversation_id,
                icon: "/icon",
              });
              notification.onclick = () => {
                window.focus();
                routerRef.current.push(conversationHref(msg.conversation_id));
                notification.close();
              };
            } catch (err) {
              console.error("[useBrowserNotifications] failed to show:", err);
            }
          })();
        }
      : undefined,
    active,
  );
}
