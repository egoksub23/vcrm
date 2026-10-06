import { describe, it, expect } from 'vitest';
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_DESCRIPTIONS,
  isWebhookEvent,
  normalizeEvents,
} from './events';

describe('isWebhookEvent', () => {
  it('accepts every declared event and rejects others', () => {
    for (const e of WEBHOOK_EVENTS) expect(isWebhookEvent(e)).toBe(true);
    expect(isWebhookEvent('message.deleted')).toBe(false);
    expect(isWebhookEvent(42)).toBe(false);
  });
});

describe('every event has a description', () => {
  it('covers the vocabulary', () => {
    for (const e of WEBHOOK_EVENTS) {
      expect(WEBHOOK_EVENT_DESCRIPTIONS[e]).toBeTruthy();
    }
  });
});

describe('normalizeEvents', () => {
  it('de-duplicates a valid list', () => {
    expect(
      normalizeEvents(['message.received', 'message.received', 'conversation.created'])
    ).toEqual(['message.received', 'conversation.created']);
  });

  it('rejects an unknown event', () => {
    expect(normalizeEvents(['message.received', 'nope'])).toBeNull();
  });

  it('rejects a non-array and an empty array', () => {
    expect(normalizeEvents('message.received')).toBeNull();
    expect(normalizeEvents([])).toBeNull();
  });
});

describe('Doc Sign events', () => {
  const SIGN = ['sign.sent', 'sign.viewed', 'sign.completed', 'sign.declined', 'sign.expired', 'sign.voided'];

  it('are part of the vocabulary, each with a description', () => {
    for (const e of SIGN) {
      expect(isWebhookEvent(e)).toBe(true);
      expect(WEBHOOK_EVENT_DESCRIPTIONS[e as keyof typeof WEBHOOK_EVENT_DESCRIPTIONS]).toBeTruthy();
    }
  });

  it('can be subscribed to, next to the older events', () => {
    expect(normalizeEvents(['sign.completed', 'message.received', 'sign.completed'])).toEqual(['sign.completed', 'message.received']);
    expect(normalizeEvents(['sign.opened'])).toBeNull();
  });

  it('match the names the automation trigger uses, one for one', async () => {
    const { SIGN_EVENT_NAMES } = await import('@/lib/automations/sign-event');
    expect(SIGN_EVENT_NAMES.map((n) => `sign.${n}`)).toEqual(SIGN);
  });
});
