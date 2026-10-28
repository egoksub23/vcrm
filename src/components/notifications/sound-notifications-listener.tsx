"use client";

import { useSoundNotifications } from "@/hooks/use-sound-notifications";

/**
 * Headless. Mount ONCE per signed-in dashboard tab (the dashboard shell)
 * so the audible ding fires on any page, not just the inbox.
 */
export function SoundNotificationsListener() {
  useSoundNotifications();
  return null;
}
