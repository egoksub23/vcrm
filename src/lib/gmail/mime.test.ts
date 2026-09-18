import { describe, expect, it } from 'vitest';
import {
  buildRawMessage,
  decodeBase64Url,
  findAttachmentParts,
  findTextBody,
  getHeader,
  parseFromHeader,
  type GmailPayloadPart,
} from './mime';

function decodeRaw(raw: string): string {
  return decodeBase64Url(raw).toString('utf-8');
}

describe('buildRawMessage', () => {
  it('builds a plain text message with the right headers', () => {
    const raw = buildRawMessage({ toAddress: 'jane@example.com', subject: 'Hi', text: 'Hello there' });
    const decoded = decodeRaw(raw);
    expect(decoded).toContain('To: jane@example.com');
    expect(decoded).toContain('Subject: Hi');
    expect(decoded).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(decoded).toContain('Hello there');
    expect(decoded).not.toContain('In-Reply-To');
  });

  it('MIME-encodes a non-ASCII subject (RFC 2047)', () => {
    const raw = buildRawMessage({ toAddress: 'a@b.com', subject: 'Café ☕', text: 'hi' });
    const decoded = decodeRaw(raw);
    expect(decoded).toMatch(/Subject: =\?UTF-8\?B\?/);
  });

  it('includes In-Reply-To / References when replying', () => {
    const raw = buildRawMessage({
      toAddress: 'a@b.com',
      subject: 'Re: Hi',
      text: 'reply body',
      inReplyTo: '<abc@mail.gmail.com>',
      references: '<abc@mail.gmail.com>',
    });
    const decoded = decodeRaw(raw);
    expect(decoded).toContain('In-Reply-To: <abc@mail.gmail.com>');
    expect(decoded).toContain('References: <abc@mail.gmail.com>');
  });

  it('builds a multipart/mixed message with a base64 attachment', () => {
    const raw = buildRawMessage({
      toAddress: 'a@b.com',
      subject: 'With attachment',
      text: 'see attached',
      attachment: { name: 'invoice.pdf', contentType: 'application/pdf', contentBytesBase64: 'AAAA' },
    });
    const decoded = decodeRaw(raw);
    expect(decoded).toContain('Content-Type: multipart/mixed; boundary="');
    expect(decoded).toContain('Content-Disposition: attachment; filename="invoice.pdf"');
    expect(decoded).toContain('Content-Transfer-Encoding: base64');
    expect(decoded).toContain('AAAA');
    expect(decoded).toContain('see attached');
  });
});

describe('getHeader / parseFromHeader', () => {
  it('is case-insensitive on header name lookup', () => {
    const headers = [{ name: 'Message-ID', value: '<x@y>' }];
    expect(getHeader(headers, 'message-id')).toBe('<x@y>');
    expect(getHeader(headers, 'MESSAGE-ID')).toBe('<x@y>');
  });

  it('parses a "Name" <address> From header', () => {
    expect(parseFromHeader('"Jane Doe" <jane@example.com>')).toEqual({
      name: 'Jane Doe',
      address: 'jane@example.com',
    });
  });

  it('falls back to treating a bare address as the whole value', () => {
    expect(parseFromHeader('jane@example.com')).toEqual({ name: null, address: 'jane@example.com' });
  });

  it('returns nulls for a missing header', () => {
    expect(parseFromHeader(null)).toEqual({ name: null, address: null });
  });
});

function b64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64url');
}

describe('findTextBody', () => {
  it('prefers a text/plain part over text/html', () => {
    const payload: GmailPayloadPart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('plain body') } },
        { mimeType: 'text/html', body: { data: b64('<p>html body</p>') } },
      ],
    };
    expect(findTextBody(payload)).toBe('plain body');
  });

  it('falls back to stripped text/html when there is no text/plain part', () => {
    const payload: GmailPayloadPart = {
      mimeType: 'text/html',
      body: { data: b64('<p>Hello <b>World</b></p>') },
    };
    expect(findTextBody(payload)).toBe('Hello World');
  });

  it('returns null for an attachment-only message', () => {
    const payload: GmailPayloadPart = {
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'att-1', size: 10 } }],
    };
    expect(findTextBody(payload)).toBeNull();
  });
});

describe('findAttachmentParts', () => {
  it('collects parts with both a filename and an attachmentId', () => {
    const payload: GmailPayloadPart = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('hi') } },
        {
          mimeType: 'image/png',
          filename: 'photo.png',
          body: { attachmentId: 'att-1', size: 1234 },
        },
      ],
    };
    expect(findAttachmentParts(payload)).toEqual([
      { filename: 'photo.png', mimeType: 'image/png', attachmentId: 'att-1', size: 1234 },
    ]);
  });

  it('ignores inline parts with no filename', () => {
    const payload: GmailPayloadPart = {
      parts: [{ mimeType: 'text/plain', body: { data: b64('hi') } }],
    };
    expect(findAttachmentParts(payload)).toEqual([]);
  });
});
