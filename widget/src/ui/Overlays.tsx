import { useEffect, useRef, useState } from 'preact/hooks'

import type { Translate } from '../i18n'
import type { MediaKind } from '../types'
import { formatBytes } from '../util'
import { CloseIcon, DownloadIcon, FileIcon, SendIcon } from './icons'

export interface StagedFile {
  file: File
  kind: MediaKind
  mime: string
  /** blob: URL for the preview (revoked by the owner when done). */
  url: string
}

/** WhatsApp-style "review before sending": preview, optional caption, send. */
export function MediaPreview({
  staged,
  t,
  onSend,
  onCancel,
}: {
  staged: StagedFile
  t: Translate
  onSend: (caption: string) => void
  onCancel: () => void
}) {
  const [caption, setCaption] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div class="wcw-overlay wcw-preview" role="dialog" aria-modal="true">
      <div class="wcw-overlay-bar">
        <button type="button" class="wcw-icon-btn wcw-on-dark" onClick={onCancel} aria-label={t('closePreview')}>
          <CloseIcon />
        </button>
        <span class="wcw-overlay-name">{staged.file.name}</span>
      </div>
      <div class="wcw-preview-stage">
        {staged.kind === 'image' && <img src={staged.url} alt={staged.file.name} />}
        {staged.kind === 'video' && <video src={staged.url} controls playsInline preload="metadata" />}
        {(staged.kind === 'document' || staged.kind === 'audio') && (
          <div class="wcw-preview-file">
            <FileIcon />
            <div class="wcw-preview-file-name">{staged.file.name}</div>
            <div class="wcw-preview-file-size">{formatBytes(staged.file.size)}</div>
          </div>
        )}
      </div>
      <form
        class="wcw-preview-bar"
        onSubmit={(e) => {
          e.preventDefault()
          onSend(caption.trim())
        }}
      >
        <input
          ref={inputRef}
          type="text"
          class="wcw-caption"
          placeholder={t('captionPh')}
          aria-label={t('captionPh')}
          maxLength={1000}
          value={caption}
          onInput={(e) => setCaption((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="wcw-send" aria-label={t('sendFile')} title={t('sendFile')}>
          <SendIcon />
        </button>
      </form>
    </div>
  )
}

/** Full-size view of a photo inside the panel. */
export function Lightbox({
  src,
  name,
  t,
  onClose,
}: {
  src: string
  name: string
  t: Translate
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div class="wcw-overlay wcw-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div class="wcw-overlay-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" class="wcw-icon-btn wcw-on-dark" onClick={onClose} aria-label={t('closePreview')}>
          <CloseIcon />
        </button>
        <span class="wcw-overlay-name">{name}</span>
        <a
          class="wcw-icon-btn wcw-on-dark"
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          download={name || true}
          aria-label={t('download')}
          title={t('download')}
        >
          <DownloadIcon />
        </a>
      </div>
      <div class="wcw-preview-stage">
        <img src={src} alt={name || t('imageAlt')} onClick={(e) => e.stopPropagation()} />
      </div>
    </div>
  )
}
