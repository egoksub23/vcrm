import { useEffect, useRef, useState } from 'preact/hooks'

import type { Translate } from '../i18n'
import type { Locale, LocalMessage } from '../types'
import {
  fileNameFromUrl,
  formatBytes,
  formatDuration,
  formatTime,
  splitLinks,
  tickState,
  type TickState,
} from '../util'
import { Guard } from './Guard'
import {
  ClockTick,
  DoubleTick,
  DownloadIcon,
  FailedTick,
  FileIcon,
  PauseIcon,
  PlayIcon,
  SingleTick,
} from './icons'

export function Tick({ state, t }: { state: TickState; t: Translate }) {
  const label =
    state === 'pending'
      ? t('tickPending')
      : state === 'delivered'
        ? t('tickDelivered')
        : state === 'read'
          ? t('tickRead')
          : state === 'failed'
            ? t('sendFailed')
            : t('tickSent')
  return (
    <span class={`wcw-tick wcw-tick-${state}`} role="img" aria-label={label} title={label}>
      {state === 'pending' ? (
        <ClockTick />
      ) : state === 'sent' ? (
        <SingleTick />
      ) : state === 'failed' ? (
        <FailedTick />
      ) : (
        <DoubleTick />
      )}
    </span>
  )
}

function TextWithLinks({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((part, i) =>
        part.href ? (
          <a key={i} class="wcw-link" href={part.href} target="_blank" rel="noopener noreferrer nofollow">
            {part.text}
          </a>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  )
}

/** Voice-note player: play/pause, a seekable bar and the time. Falls back to a download link. */
export function AudioPlayer({ src, durationHint, t }: { src: string; durationHint?: number | null; t: Translate }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(durationHint && durationHint > 0 ? durationHint : 0)
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    const onTime = () => setCurrent(a.currentTime)
    const onMeta = () => {
      // Streamed Ogg often reports Infinity until played through once.
      if (Number.isFinite(a.duration) && a.duration > 0) setDuration(a.duration)
    }
    const onEnd = () => {
      setPlaying(false)
      setCurrent(0)
    }
    const onErr = () => setBroken(true)
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('loadedmetadata', onMeta)
    a.addEventListener('durationchange', onMeta)
    a.addEventListener('ended', onEnd)
    a.addEventListener('error', onErr)
    return () => {
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('loadedmetadata', onMeta)
      a.removeEventListener('durationchange', onMeta)
      a.removeEventListener('ended', onEnd)
      a.removeEventListener('error', onErr)
    }
  }, [src])

  if (broken) {
    return (
      <a class="wcw-file" href={src} target="_blank" rel="noopener noreferrer" download>
        <span class="wcw-file-icon">
          <FileIcon />
        </span>
        <span class="wcw-file-body">
          <span class="wcw-file-name">{t('voiceMessage')}</span>
          <span class="wcw-file-size">{t('download')}</span>
        </span>
        <DownloadIcon />
      </a>
    )
  }

  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) {
      void a.play().then(() => setPlaying(true)).catch(() => setBroken(true))
    } else {
      a.pause()
      setPlaying(false)
    }
  }
  const seek = (e: Event) => {
    const a = audioRef.current
    const v = Number((e.target as HTMLInputElement).value)
    if (a && Number.isFinite(v)) {
      a.currentTime = v
      setCurrent(v)
    }
  }
  const shown = playing || current > 0 ? current : duration

  return (
    <div class="wcw-audio">
      <audio ref={audioRef} src={src} preload="metadata" />
      <button type="button" class="wcw-audio-btn" onClick={toggle} aria-label={playing ? t('pause') : t('play')}>
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <input
        class="wcw-audio-bar"
        type="range"
        min={0}
        max={duration || 1}
        step={0.1}
        value={Math.min(current, duration || 1)}
        onInput={seek}
        aria-label={t('voiceMessage')}
      />
      <span class="wcw-audio-time">{formatDuration(shown)}</span>
    </div>
  )
}

interface BubbleProps {
  m: LocalMessage
  locale: Locale
  t: Translate
  onRetry: (m: LocalMessage) => void
  onOpenImage: (src: string, name: string) => void
  /** Media finished loading and changed the bubble's height (lets the list stay pinned to the bottom). */
  onMediaLoad?: () => void
}

export function BubbleImpl({ m, locale, t, onRetry, onOpenImage, onMediaLoad }: BubbleProps) {
  const mine = m.sender_type === 'customer'
  const src = m.localUrl || m.media_url || ''
  const type = m.content_type || 'text'
  const hasMedia = !!src && type !== 'text'
  const caption = m.content_text?.trim() || ''
  const tick = tickState(m)
  const name = m.localFileName || (m.media_url ? fileNameFromUrl(m.media_url) : '')
  const mediaOnly = hasMedia && (type === 'image' || type === 'video') && !caption
  const time = formatTime(m.created_at, locale)

  const meta = (
    <span class="wcw-meta">
      <span class="wcw-time">{time}</span>
      {mine && tick && <Tick state={tick} t={t} />}
    </span>
  )

  return (
    <div
      class={`wcw-row wcw-row-${mine ? 'me' : 'them'}`}
      onClick={m.failed ? () => onRetry(m) : undefined}
      role={m.failed ? 'button' : undefined}
    >
      <div
        class={`wcw-bubble wcw-${mine ? 'customer' : 'agent'}${m.pending ? ' wcw-pending' : ''}${m.failed ? ' wcw-failed' : ''}${hasMedia ? ' wcw-has-media' : ''}${mediaOnly ? ' wcw-media-only' : ''}`}
      >
        {hasMedia && type === 'image' && (
          <button
            type="button"
            class="wcw-media wcw-media-btn"
            aria-label={t('openImage')}
            onClick={(e) => {
              e.stopPropagation()
              onOpenImage(src, name)
            }}
          >
            <img src={src} alt={t('imageAlt')} onLoad={onMediaLoad} />
            {m.pending && <span class="wcw-spinner" aria-hidden="true" />}
          </button>
        )}
        {hasMedia && type === 'video' && (
          <div class="wcw-media">
            <video src={src} controls playsInline preload="metadata" onLoadedMetadata={onMediaLoad} />
            {m.pending && <span class="wcw-spinner" aria-hidden="true" />}
          </div>
        )}
        {hasMedia && type === 'audio' && (
          <AudioPlayer src={src} durationHint={m.localDurationSeconds} t={t} />
        )}
        {hasMedia && type !== 'image' && type !== 'video' && type !== 'audio' && (
          <a
            class="wcw-file"
            href={m.localUrl ? undefined : src}
            target="_blank"
            rel="noopener noreferrer"
            download={name || true}
            onClick={(e) => e.stopPropagation()}
          >
            <span class="wcw-file-icon">
              <FileIcon />
            </span>
            <span class="wcw-file-body">
              <span class="wcw-file-name">{name || t('download')}</span>
              {m.localSizeBytes ? <span class="wcw-file-size">{formatBytes(m.localSizeBytes)}</span> : null}
            </span>
            {m.pending ? <span class="wcw-spinner wcw-spinner-inline" aria-hidden="true" /> : <DownloadIcon />}
          </a>
        )}
        {caption && (
          <div class="wcw-text">
            <TextWithLinks text={caption} />
          </div>
        )}
        {meta}
      </div>
      {m.failed && <div class="wcw-failed-note">{m.retry?.file ? t('uploadFailed') : t('sendFailed')}</div>}
    </div>
  )
}

/** What a message shows when it could not be rendered: never blank, still offers its file. */
export function MessageFallback({ m, t }: { m: LocalMessage; t: Translate }) {
  const mine = m.sender_type === 'customer'
  const href = m.media_url && /^https?:\/\//i.test(m.media_url) ? m.media_url : null
  return (
    <div class={`wcw-row wcw-row-${mine ? 'me' : 'them'}`}>
      <div class={`wcw-bubble wcw-${mine ? 'customer' : 'agent'}`}>
        <div class="wcw-text">{t('messageUnavailable')}</div>
        {href && (
          <a class="wcw-link" href={href} target="_blank" rel="noopener noreferrer nofollow">
            {t('download')}
          </a>
        )}
      </div>
    </div>
  )
}

/** One bad message degrades to MessageFallback; it can never blank the whole chat. */
export function Bubble(props: BubbleProps) {
  const m = props.m
  return (
    <Guard
      resetKey={`${m.id}|${m.status ?? ''}|${m.content_type ?? ''}|${m.media_url ?? ''}`}
      fallback={() => <MessageFallback m={m} t={props.t} />}
    >
      <BubbleImpl {...props} />
    </Guard>
  )
}
