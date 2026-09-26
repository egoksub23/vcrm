import { describe, expect, it } from 'vitest';

import {
  generateVerificationCode,
  hashVerificationCode,
  maskEmail,
} from './verification-code';

describe('generateVerificationCode', () => {
  it('is always a zero-padded 6-digit string', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateVerificationCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});

describe('hashVerificationCode', () => {
  it('is deterministic', () => {
    expect(hashVerificationCode('123456')).toBe(hashVerificationCode('123456'));
  });

  it('differs for different codes', () => {
    expect(hashVerificationCode('123456')).not.toBe(
      hashVerificationCode('654321')
    );
  });

  it('is not the plaintext code', () => {
    expect(hashVerificationCode('123456')).not.toBe('123456');
  });
});

describe('maskEmail', () => {
  it('keeps the first local-part character and the whole domain', () => {
    expect(maskEmail('real@example.com')).toBe('r***@example.com');
  });

  it('pads short local parts to at least 3 stars', () => {
    expect(maskEmail('jo@example.com')).toBe('j***@example.com');
  });

  it('falls back to *** for something with no @', () => {
    expect(maskEmail('not-an-email')).toBe('***');
  });
});
