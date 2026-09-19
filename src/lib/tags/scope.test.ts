import { describe, expect, it } from 'vitest';

import { isContactTag, isConversationLabel } from './scope';

describe('tag scope flags', () => {
  it('treats a row with neither flag (pre-068 / hand-built) as both', () => {
    expect(isContactTag({})).toBe(true);
    expect(isConversationLabel({})).toBe(true);
  });

  it('honours an explicit false, and only that', () => {
    expect(isContactTag({ for_contacts: false })).toBe(false);
    expect(isContactTag({ for_contacts: true })).toBe(true);
    expect(isConversationLabel({ for_conversations: false })).toBe(false);
    expect(isConversationLabel({ for_conversations: true })).toBe(true);
  });
});
