// ============================================================
// Tests for the link-preview extraction logic (pure, no network).
// The route itself is not integration-tested here because it needs
// requireCapability; the pure extraction helpers live in
// src/lib/sembang/link-preview.ts and are tested separately.
// This file tests the URL-validation and siteName-extraction logic
// that live only in the route module.
// ============================================================
import { describe, expect, it } from 'vitest'
import { extractLinkPreviewMeta } from '@/lib/sembang/link-preview'

// --- extractLinkPreviewMeta -------------------------------------------------

describe('extractLinkPreviewMeta', () => {
  it('extracts og:title, og:description, og:image', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Hello World">
        <meta property="og:description" content="A test page">
        <meta property="og:image" content="https://example.com/img.png">
      </head><body></body></html>
    `
    const meta = extractLinkPreviewMeta(html, 'https://example.com/page')
    expect(meta.title).toBe('Hello World')
    expect(meta.description).toBe('A test page')
    expect(meta.imageUrl).toBe('https://example.com/img.png')
    expect(meta.domain).toBe('example.com')
  })

  it('falls back to <title> when og:title is absent', () => {
    const html = `<html><head><title>Fallback Title</title></head><body></body></html>`
    const meta = extractLinkPreviewMeta(html, 'https://example.com/')
    expect(meta.title).toBe('Fallback Title')
  })

  it('resolves a relative og:image against the page URL', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Relative Image">
        <meta property="og:image" content="/assets/hero.jpg">
      </head><body></body></html>
    `
    const meta = extractLinkPreviewMeta(html, 'https://example.com/page')
    expect(meta.imageUrl).toBe('https://example.com/assets/hero.jpg')
  })

  it('returns null title when neither og:title nor <title> present', () => {
    const html = `<html><head></head><body>No title here</body></html>`
    const meta = extractLinkPreviewMeta(html, 'https://example.com/')
    expect(meta.title).toBeNull()
  })

  it('prefers og:title over twitter:title', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="OG Title">
        <meta name="twitter:title" content="Twitter Title">
      </head></html>
    `
    const meta = extractLinkPreviewMeta(html, 'https://example.com/')
    expect(meta.title).toBe('OG Title')
  })

  it('falls back to twitter:title when og:title missing', () => {
    const html = `
      <html><head>
        <meta name="twitter:title" content="Twitter Title">
      </head></html>
    `
    const meta = extractLinkPreviewMeta(html, 'https://example.com/')
    expect(meta.title).toBe('Twitter Title')
  })

  it('truncates very long title to 300 chars', () => {
    const longTitle = 'a'.repeat(400)
    const html = `<html><head><title>${longTitle}</title></head></html>`
    const meta = extractLinkPreviewMeta(html, 'https://example.com/')
    expect(meta.title?.length).toBe(300)
  })

  it('truncates very long description to 500 chars', () => {
    const longDesc = 'b'.repeat(600)
    const html = `
      <html><head>
        <meta property="og:title" content="T">
        <meta property="og:description" content="${longDesc}">
      </head></html>
    `
    const meta = extractLinkPreviewMeta(html, 'https://example.com/')
    expect(meta.description?.length).toBe(500)
  })

  it('extracts domain from the page URL', () => {
    const html = `<html><head><title>T</title></head></html>`
    const meta = extractLinkPreviewMeta(html, 'https://www.news.example.co.uk/story/123')
    expect(meta.domain).toBe('www.news.example.co.uk')
  })
})
