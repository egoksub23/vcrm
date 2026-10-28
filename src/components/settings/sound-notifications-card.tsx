"use client";

import { useSyncExternalStore } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  playNotificationSound,
  writeSoundNotifyPref,
  readSoundNotifyPref,
  subscribeSoundNotifyPref,
} from "@/lib/notifications/sound";

/**
 * "Sound notifications" card — device-scoped opt-in for the audible ding
 * on new customer messages and system events (assignments, mentions, etc.).
 * Mirrors the BrowserNotificationsCard pattern. Persistence: localStorage.
 */
export function SoundNotificationsCard({ className }: { className?: string }) {
  const t = useTranslations("Settings.soundNotifications");
  // useSoundNotifyPref uses useSyncExternalStore internally — read it for
  // the checked state, and use a direct read here for the server snapshot.
  const enabled = useSyncExternalStore(
    subscribeSoundNotifyPref,
    readSoundNotifyPref,
    () => false,
  );

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          {enabled ? (
            <Volume2 className="size-4 text-muted-foreground" />
          ) : (
            <VolumeX className="size-4 text-muted-foreground" />
          )}
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{t("toggleLabel")}</p>
            <p className="text-xs text-muted-foreground">{t("toggleDesc")}</p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(next) => writeSoundNotifyPref(next)}
            aria-label={t("toggleLabel")}
          />
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => playNotificationSound()}
          disabled={!enabled}
        >
          <Volume2 className="size-4" />
          {t("playTest")}
        </Button>
      </CardContent>
    </Card>
  );
}
