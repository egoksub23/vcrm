'use client';

import { useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import {
  BATCH_SEND_ATTEMPTS,
  batchRetryDelayMs,
} from '@/lib/broadcast-retry';
import { Contact, MessageTemplate } from '@/types';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without
   * it. Passed through as `messageParams.headerMediaUrl`; the builder
   * falls back to the template's stored URL only when this is empty.
   */
  headerMediaUrl?: string;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

/**
 * Meta rate-limit buffer. 10 per batch + 1 s pause matches the spec
 * and keeps us comfortably under Meta's per-phone-number messaging
 * rate so a large broadcast never trips the upstream limiter.
 *
 * Note this shape when touching `RATE_LIMITS.broadcast`: a campaign is
 * many calls to `/api/whatsapp/broadcast`, not one. A 1 000-recipient
 * send is ~100 calls over several minutes, and a bucket sized for
 * "one call per campaign" throttles most of it away (issue #472).
 */
const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BroadcastApiResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

interface BroadcastRecipient {
  id: string;
  broadcast_id: string;
  contact_id: string;
  status: string;
  template_params: string[];
  contact?: Contact | null;
}

/**
 * Per-contact resolution of custom-field placeholders. Static and
 * built-in-field mappings resolve synchronously; custom fields read
 * from a pre-built index to avoid N+1 queries during the send loop.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  // Keys are typically "1","2",... — numeric-aware sort keeps
  // {{1}} before {{10}}.
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;

    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }

    // custom_field
    return customValues?.get(v.value) ?? '';
  });
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    try {
      if (!accountId) {
        throw new Error('Your profile is not linked to an account.');
      }

      // ── Steps 0–3: Resolve audience, create broadcast, insert recipients ──
      setProgress(5);
      const createRes = await fetch('/api/broadcasts/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: payload.name,
          template: payload.template,
          audience: payload.audience,
          variables: payload.variables,
        }),
      });
      const createJson = (await createRes.json()) as {
        broadcastId?: string;
        recipients?: BroadcastRecipient[];
        error?: string;
      };
      if (!createRes.ok || !createJson.broadcastId || !createJson.recipients) {
        throw new Error(createJson.error ?? 'Failed to create broadcast');
      }

      const broadcastId = createJson.broadcastId;
      const recipients = createJson.recipients;

      if (recipients.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      // ── Step 4: Send to each recipient in batches ─────────────────────
      setProgress(30);
      let failedCount = 0;
      const totalRecipients = recipients.length;

      const headerType = payload.template.header_type;
      const isMediaHeader =
        headerType === 'image' ||
        headerType === 'video' ||
        headerType === 'document';
      const headerMediaUrl = payload.headerMediaUrl?.trim();
      const messageParams =
        isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined;

      for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
        const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

        const apiRecipients = batch
          .filter((r) => r.contact?.phone)
          .map((r) => ({
            phone: r.contact!.phone as string,
            params: Array.isArray(r.template_params) ? r.template_params : [],
            ...(messageParams ? { messageParams } : {}),
          }));

        if (apiRecipients.length === 0) continue;

        try {
          let data: { error?: string; results?: BroadcastApiResult[] } = {};
          for (let attempt = 1; ; attempt++) {
            const res = await fetch('/api/whatsapp/broadcast', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                recipients: apiRecipients,
                template_name: payload.template.name,
                template_language: payload.template.language ?? 'en_US',
              }),
            });

            data = await res.json();
            if (res.ok) break;

            const retryIn =
              attempt < BATCH_SEND_ATTEMPTS
                ? batchRetryDelayMs(res.status, res.headers.get('Retry-After'))
                : null;
            if (retryIn === null) {
              throw new Error(data.error || 'Broadcast API request failed');
            }
            await sleep(retryIn);
          }

          const resultsByPhone = new Map<string, BroadcastApiResult>();
          for (const r of (data.results ?? []) as BroadcastApiResult[]) {
            resultsByPhone.set(r.phone, r);
          }

          for (const recipient of batch) {
            const phone = recipient.contact?.phone;
            const result = phone ? resultsByPhone.get(phone) : undefined;

            if (!result) {
              failedCount++;
              await fetch(
                `/api/broadcasts/${encodeURIComponent(broadcastId)}/recipients/${encodeURIComponent(recipient.id)}`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    status: 'failed',
                    error_message: 'No phone number on contact',
                  }),
                },
              );
              continue;
            }

            if (result.status === 'sent') {
              await fetch(
                `/api/broadcasts/${encodeURIComponent(broadcastId)}/recipients/${encodeURIComponent(recipient.id)}`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    status: 'sent',
                    sent_at: new Date().toISOString(),
                    whatsapp_message_id: result.whatsapp_message_id ?? null,
                    error_message: null,
                  }),
                },
              );
            } else {
              failedCount++;
              await fetch(
                `/api/broadcasts/${encodeURIComponent(broadcastId)}/recipients/${encodeURIComponent(recipient.id)}`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    status: 'failed',
                    error_message: result.error ?? 'Unknown error',
                  }),
                },
              );
            }
          }
        } catch (err) {
          for (const recipient of batch) {
            failedCount++;
            await fetch(
              `/api/broadcasts/${encodeURIComponent(broadcastId)}/recipients/${encodeURIComponent(recipient.id)}`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  status: 'failed',
                  error_message: err instanceof Error ? err.message : 'Unknown error',
                }),
              },
            );
          }
        }

        const progressPct =
          30 + Math.round(((i + batch.length) / totalRecipients) * 60);
        setProgress(progressPct);

        if (i + SEND_BATCH_SIZE < recipients.length) {
          await sleep(SEND_BATCH_DELAY_MS);
        }
      }

      // ── Step 5: Finalize broadcast status ────────────────────────────
      setProgress(95);
      const finalStatus = failedCount === totalRecipients ? 'failed' : 'sent';
      await fetch(`/api/broadcasts/${encodeURIComponent(broadcastId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: finalStatus }),
      });

      setProgress(100);
      return broadcastId;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
