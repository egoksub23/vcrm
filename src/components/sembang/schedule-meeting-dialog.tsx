"use client";

// "Schedule a meeting" (P4) — creates a real calendar event (Google Meet
// or Microsoft Teams, whichever the account has connected) via the
// shared connected mailbox's own OAuth, with every other member of this
// channel invited. See POST /api/sembang/channels/[id]/schedule.
//
// Reads connection status from the same GET routes the Settings →
// Channels panels already use (src/app/api/account/channels/gmail,
// .../email) — any account member can read those (migrations 056/058),
// so this needs no new "is calendar available" endpoint.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

type CalendarProvider = "google" | "ms365";

interface ScheduledMeeting {
  provider: CalendarProvider;
  title: string;
  htmlLink: string;
  meetingUrl: string | null;
  /** Pre-formatted in the scheduler's own local time/locale (e.g. "Thu,
   *  Oct 1 at 2:00 PM") — the caller posts this as-is rather than
   *  reformatting `startAt`, which would need a second, error-prone
   *  local-vs-UTC reinterpretation to get right. */
  when: string;
  attendeeCount: number;
}

interface ScheduleMeetingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  channelName: string;
  memberCount: number;
  onScheduled: (meeting: ScheduledMeeting) => void;
}

const DURATION_OPTIONS = [15, 30, 45, 60, 90] as const;

function defaultDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function roundedUpcomingTime(): string {
  const d = new Date(Date.now() + 15 * 60_000);
  const minutes = Math.ceil(d.getMinutes() / 15) * 15;
  d.setMinutes(minutes, 0, 0);
  return d.toTimeString().slice(0, 5);
}

/** `date` + `time` (both from native inputs, local wall-clock, no
 *  offset) → the naive-local-datetime string both calendar APIs expect
 *  when paired with an explicit `timeZone` field. */
function toNaiveLocalIso(date: string, time: string): string {
  return `${date}T${time}:00`;
}

export function ScheduleMeetingDialog({
  open,
  onOpenChange,
  channelId,
  channelName,
  memberCount,
  onScheduled,
}: ScheduleMeetingDialogProps) {
  const t = useTranslations("Sembang.scheduleMeeting");

  const [checkingConnections, setCheckingConnections] = useState(true);
  const [availableProviders, setAvailableProviders] = useState<CalendarProvider[]>([]);
  const [provider, setProvider] = useState<CalendarProvider | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState(roundedUpcomingTime);
  const [duration, setDuration] = useState<number>(30);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCheckingConnections(true);
    Promise.all([
      fetch("/api/account/channels/gmail")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch("/api/account/channels/email")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([gmail, email]) => {
        if (cancelled) return;
        const providers: CalendarProvider[] = [];
        if (gmail?.connected) providers.push("google");
        if (email?.connected) providers.push("ms365");
        setAvailableProviders(providers);
        setProvider(providers[0] ?? null);
      })
      .finally(() => {
        if (!cancelled) setCheckingConnections(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const reset = () => {
    setTitle("");
    setDescription("");
    setDate(defaultDate());
    setTime(roundedUpcomingTime());
    setDuration(30);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleSchedule = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || !provider || saving) return;
    setSaving(true);
    try {
      const startAt = toNaiveLocalIso(date, time);
      // Wall-clock arithmetic: parse the naive local time as if it were
      // UTC (a trick, not a real timezone conversion) so Date's minute
      // math can run on it, then read the result back the same naive
      // way — this yields the correct end-of-meeting clock time
      // regardless of the visitor's actual offset, without needing a
      // timezone-aware date library.
      const endDate = new Date(`${startAt}Z`);
      endDate.setUTCMinutes(endDate.getUTCMinutes() + duration);
      const endAt = endDate.toISOString().slice(0, 19);
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      // Genuinely local (no Z/offset suffix parses as local time per the
      // spec) — unlike the fake-UTC trick above, this is for display, in
      // the scheduler's own browser locale.
      const when = format(new Date(startAt), "EEE, MMM d 'at' h:mm a");

      const res = await fetch(`/api/sembang/channels/${channelId}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          title: trimmedTitle,
          description: description.trim() || undefined,
          startAt,
          endAt,
          timeZone,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t("scheduleFailed"));
        return;
      }
      onScheduled({
        provider,
        title: trimmedTitle,
        htmlLink: data.htmlLink,
        meetingUrl: data.meetingUrl ?? null,
        when,
        attendeeCount: data.attendeeCount ?? 0,
      });
      handleOpenChange(false);
    } catch {
      toast.error(t("scheduleFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { channel: channelName, count: memberCount })}
          </DialogDescription>
        </DialogHeader>

        {checkingConnections ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : availableProviders.length === 0 ? (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
            {t("noCalendarConnected")}
          </p>
        ) : (
          <div className="space-y-3">
            {availableProviders.length > 1 && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t("calendarLabel")}</label>
                <Select value={provider ?? undefined} onValueChange={(v) => setProvider(v as CalendarProvider)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="google">{t("providerGoogle")}</SelectItem>
                    <SelectItem value="ms365">{t("providerMs365")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t("titleLabel")}</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("titlePlaceholder")} />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2 space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t("dateLabel")}</label>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t("timeLabel")}</label>
                <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t("durationLabel")}</label>
              <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATION_OPTIONS.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {t("durationMinutes", { minutes })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t("notesLabel")}</label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("notesPlaceholder")}
                rows={2}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
            {t("cancel")}
          </Button>
          <Button onClick={handleSchedule} disabled={!title.trim() || !provider || saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("schedule")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
