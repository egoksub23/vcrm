'use client';

import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { CheckCircle2, TriangleAlert } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { invalidateMailInbox } from '@/hooks/use-mail-inbox';
import { patchMailboxSwitch, sendLine, type MailboxSwitchRefusal } from '@/lib/inbox/mailbox-switch-client';

const OK_COLOR = { color: 'light-dark(#047857, #6ee7b7)' } as const;
const WARN_COLOR = { color: 'light-dark(#b45309, #fcd34d)' } as const;

/** The fields of a connected mailbox the switches read and keep current. */
export interface MailboxSwitchState {
  status?: string | null;
  needs_reauth?: boolean | null;
  /** The master pause: false = paused. */
  enabled?: boolean;
  /** Use this mailbox for the customer care inbox. */
  inbox_enabled?: boolean;
}

/**
 * The two independent controls of a connected mailbox (Settings > Channels > Email and > Gmail), in plain words:
 *
 *   1. "Customer care inbox" - a switch. On: the mailbox's emails come into the Halo Inbox and agents reply from there. Off: nothing new comes in, replies
 *      by email are not offered, emails already in the Inbox stay as history. Turning it on starts from that moment; nothing is imported.
 *   2. "Send Halo emails from this mailbox" - a status line, not a switch: Halo's own emails (Secure Sign, invitations, notifications) go out from this
 *      mailbox whenever it is connected and not paused, whatever the inbox switch says. The line says so, or why not.
 *   3. "Pause this mailbox completely" - the master switch (it was the channel's Enabled switch): stops everything, in and out. The connection is kept.
 *
 * Each switch saves at once through the channel's own PATCH route and tells the person what happened.
 */
export function MailboxSwitches({
  patchUrl,
  idPrefix,
  mailbox,
  address,
  disabled,
  onChange,
  extra,
}: {
  patchUrl: string;
  idPrefix: string;
  mailbox: MailboxSwitchState;
  address?: string | null;
  /** Read-only viewer (missing channels.manage): same gate as Disconnect. */
  disabled?: boolean;
  onChange: (patch: { enabled?: boolean; inbox_enabled?: boolean }) => void;
  /** Provider-specific words shown under the inbox switch while it is on (e.g. Gmail's push setup). */
  extra?: ReactNode;
}) {
  const t = useTranslations('Settings.channels.mailbox');
  const [savingInbox, setSavingInbox] = useState(false);
  const [savingPause, setSavingPause] = useState(false);

  const inboxOn = mailbox.inbox_enabled !== false;
  const paused = mailbox.enabled === false;
  const send = sendLine(mailbox);

  const refusal = (reason: MailboxSwitchRefusal) => t(`refusal.${reason}`);

  async function toggleInbox(next: boolean) {
    setSavingInbox(true);
    try {
      const outcome = await patchMailboxSwitch(patchUrl, { inbox_enabled: next });
      if (!outcome.ok) {
        toast.error(refusal(outcome.reason));
        return;
      }
      onChange({ inbox_enabled: next });
      invalidateMailInbox();
      if (outcome.note === 'stop_failed') toast.warning(t('inboxOffStopFailed'));
      else if (outcome.note === 'no_push') toast.warning(t('inboxOnNoPush'));
      else toast.success(next ? t('inboxOnToast') : t('inboxOffToast'));
    } finally {
      setSavingInbox(false);
    }
  }

  async function togglePause(nextPaused: boolean) {
    // pausing takes effect at once: show it, and put it back if the write fails
    onChange({ enabled: !nextPaused });
    setSavingPause(true);
    try {
      const outcome = await patchMailboxSwitch(patchUrl, { enabled: !nextPaused });
      if (!outcome.ok) {
        onChange({ enabled: nextPaused });
        toast.error(refusal(outcome.reason));
        return;
      }
      toast.success(nextPaused ? t('pausedToast') : t('resumedToast'));
    } finally {
      setSavingPause(false);
    }
  }

  const sendWho = address ? t('sendDescription', { mailbox: address }) : t('sendDescriptionNoAddress');

  return (
    <Card className="mt-6" data-mailbox-switches={idPrefix}>
      <CardContent className="divide-y divide-border py-0">
        <section className="flex flex-col gap-3 py-5 sm:flex-row sm:items-start sm:justify-between" aria-labelledby={`${idPrefix}-inbox-label`}>
          <div className="min-w-0 space-y-1">
            <Label id={`${idPrefix}-inbox-label`} htmlFor={`${idPrefix}-inbox`} className="text-sm font-medium text-foreground">
              {t('inboxTitle')}
            </Label>
            <p className="max-w-[62ch] text-sm text-muted-foreground">{t('inboxDescription')}</p>
            {inboxOn ? (
              extra
            ) : (
              <p role="status" data-inbox-off className="max-w-[62ch] text-xs" style={WARN_COLOR}>
                {t('inboxOffNote')}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-sm text-muted-foreground">{inboxOn ? t('on') : t('off')}</span>
            <Switch id={`${idPrefix}-inbox`} checked={inboxOn} onCheckedChange={(v) => void toggleInbox(v)} disabled={disabled || savingInbox} />
          </div>
        </section>

        <section className="space-y-1 py-5" aria-labelledby={`${idPrefix}-send-label`} data-send-line={send}>
          <h3 id={`${idPrefix}-send-label`} className="text-sm font-medium text-foreground">
            {t('sendTitle')}
          </h3>
          <p className="flex items-start gap-2 text-sm" role="status" style={send === 'used' ? OK_COLOR : WARN_COLOR}>
            {send === 'used' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
            <span>{t(`send.${send}`)}</span>
          </p>
          <p className="max-w-[62ch] text-sm text-muted-foreground">{sendWho}</p>
        </section>

        <section className="flex flex-col gap-3 py-5 sm:flex-row sm:items-start sm:justify-between" aria-labelledby={`${idPrefix}-pause-label`}>
          <div className="min-w-0 space-y-1">
            <Label id={`${idPrefix}-pause-label`} htmlFor={`${idPrefix}-pause`} className="text-sm font-medium text-foreground">
              {t('pauseTitle')}
            </Label>
            <p className="max-w-[62ch] text-sm text-muted-foreground">{t('pauseDescription')}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-sm text-muted-foreground">{paused ? t('on') : t('off')}</span>
            <Switch id={`${idPrefix}-pause`} checked={paused} onCheckedChange={(v) => void togglePause(v)} disabled={disabled || savingPause} />
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
