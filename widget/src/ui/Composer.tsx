import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import type { Translate } from '../i18n'
import { isSilentTake, listMicrophones, type MicOption } from '../mic'
import { startVoiceRecording } from '../recorder'
import { VoiceError, type VoiceHandle, type VoiceResult } from '../recorder-strategy'
import { readSavedMic, writeSavedMic } from '../storage'
import type { WidgetLimits } from '../types'
import { acceptAttribute, formatDuration } from '../util'
import { EmojiPicker } from './EmojiPicker'
import { KeyboardIcon, MicIcon, PaperclipIcon, SendIcon, SmileIcon, TrashIcon } from './icons'

interface ComposerProps {
  t: Translate
  limits: WidgetLimits
  disabled: boolean
  /** Whether this browser can produce an allowed voice-note format. */
  canRecord: boolean
  onSendText: (text: string) => void
  onFileChosen: (file: File) => void
  onSendVoice: (result: VoiceResult) => void
  onError: (message: string) => void
}

const MAX_TEXT = 4000

function isTouchPrimary(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}

export function Composer({
  t,
  limits,
  disabled,
  canRecord,
  onSendText,
  onFileChosen,
  onSendVoice,
  onError,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [voice, setVoice] = useState<'idle' | 'starting' | 'recording' | 'confirm'>('idle')
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  // "We cannot hear you": the hint, the compact microphone list, and the take held back for confirmation.
  const [silentHint, setSilentHint] = useState(false)
  const [micOptions, setMicOptions] = useState<MicOption[] | null>(null)
  const [micId, setMicId] = useState<string | null>(null)
  const pendingRef = useRef<VoiceResult | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const handleRef = useRef<VoiceHandle | null>(null)
  const timerRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)
  // The recording timer outlives renders, so it reads the latest callbacks from here.
  const latest = useRef({ onError, onSendVoice, t })
  latest.current = { onError, onSendVoice, t }

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Grow the textarea with its content (up to ~5 lines).
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`
  }, [text])

  // A take left running when the panel unmounts is discarded.
  useEffect(
    () => () => {
      clearTimer()
      handleRef.current?.cancel()
      handleRef.current = null
    },
    [clearTimer],
  )

  const submitText = () => {
    const value = text.trim()
    if (!value || disabled) return
    onSendText(value)
    setText('')
    setEmojiOpen(false)
    inputRef.current?.focus()
  }

  const insertEmoji = (emoji: string) => {
    const el = inputRef.current
    if (!el) {
      setText((v) => v + emoji)
      return
    }
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    const next = text.slice(0, start) + emoji + text.slice(end)
    setText(next)
    const caret = start + emoji.length
    requestAnimationFrame(() => {
      el.setSelectionRange(caret, caret)
    })
  }

  const finishRecording = useCallback(
    async (send: boolean) => {
      const handle = handleRef.current
      handleRef.current = null
      clearTimer()
      setVoice('idle')
      setSeconds(0)
      setLevel(0)
      setSilentHint(false)
      setMicOptions(null)
      if (!handle) return
      if (!send) {
        handle.cancel()
        return
      }
      const signal = handle.getSignal?.()
      try {
        const result = await handle.stop()
        if (result.blob.size === 0) {
          latest.current.onError(latest.current.t('recordingFailed'))
          return
        }
        // Never send a take with no sound in it without asking first.
        const peak = handle.getSignal?.().maxPeak ?? signal?.maxPeak
        if (peak !== undefined && isSilentTake(peak)) {
          pendingRef.current = result
          setMicId(handle.deviceId ?? null)
          setVoice('confirm')
          return
        }
        latest.current.onSendVoice(result)
      } catch {
        latest.current.onError(latest.current.t('recordingFailed'))
      }
    },
    [clearTimer],
  )

  const beginRecording = async (deviceId: string | null) => {
    setEmojiOpen(false)
    setVoice('starting')
    setSilentHint(false)
    setMicOptions(null)
    try {
      const handle = await startVoiceRecording(limits.allowedMimeTypes, deviceId)
      handleRef.current = handle
      startedAtRef.current = Date.now()
      setSeconds(0)
      setMicId(handle.deviceId ?? deviceId)
      setVoice('recording')
      timerRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000)
        setSeconds(elapsed)
        setLevel(handleRef.current?.getLevel?.() ?? 0)
        setSilentHint(handleRef.current?.getSignal?.().showHint ?? false)
        if (elapsed >= limits.maxVoiceSeconds) void finishRecording(true)
      }, 200)
    } catch (err) {
      setVoice('idle')
      const code = err instanceof VoiceError ? err.code : 'failed'
      onError(code === 'denied' ? t('micDenied') : code === 'unsupported' ? t('micUnsupported') : t('recordingFailed'))
    }
  }

  const startRecording = async () => {
    if (disabled || voice !== 'idle') return
    await beginRecording(readSavedMic())
  }

  const openMicList = async () => {
    setMicOptions(await listMicrophones((n) => t('micFallbackName', { n })))
  }

  // Picking a microphone remembers it and starts the take again on that device.
  const chooseMic = async (id: string) => {
    writeSavedMic(id)
    clearTimer()
    handleRef.current?.cancel()
    handleRef.current = null
    pendingRef.current = null
    await beginRecording(id)
  }

  const micPicker = micOptions && (
    <div class="wcw-mic-list" role="listbox" aria-label={t('micChoose')}>
      {micOptions.length === 0 && <div class="wcw-mic-none">{t('micNone')}</div>}
      {micOptions.map((o) => (
        <button
          key={o.id}
          type="button"
          role="option"
          aria-selected={o.id === micId}
          class={`wcw-mic-opt${o.id === micId ? ' wcw-on' : ''}`}
          onClick={() => void chooseMic(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )

  const hasText = text.trim().length > 0

  if (voice === 'confirm') {
    return (
      <div class="wcw-composer-wrap">
        <div class="wcw-mic-hint" role="alert">
          <span>{t('micSilentSend')}</span>
          <div class="wcw-mic-actions">
            <button
              type="button"
              class="wcw-linkbtn"
              onClick={() => {
                pendingRef.current = null
                setMicOptions(null)
                setVoice('idle')
              }}
            >
              {t('discard')}
            </button>
            <button type="button" class="wcw-linkbtn" onClick={() => void openMicList()}>
              {t('micChange')}
            </button>
            <button
              type="button"
              class="wcw-linkbtn wcw-strong"
              onClick={() => {
                const r = pendingRef.current
                pendingRef.current = null
                setMicOptions(null)
                setVoice('idle')
                if (r) latest.current.onSendVoice(r)
              }}
            >
              {t('sendAnyway')}
            </button>
          </div>
          {micPicker}
        </div>
      </div>
    )
  }

  if (voice === 'recording') {
    // Ten level bars; the loudest recent input lights more of them.
    const lit = Math.round(level * 10)
    return (
      <div class="wcw-composer-wrap">
        {silentHint && (
          <div class="wcw-mic-hint" role="alert">
            <span>{t('micSilent')}</span>
            <div class="wcw-mic-actions">
              <button type="button" class="wcw-linkbtn wcw-strong" onClick={() => void openMicList()}>
                {t('micChange')}
              </button>
            </div>
            {micPicker}
          </div>
        )}
        <div class="wcw-composer wcw-composer-rec">
          <button type="button" class="wcw-icon-btn wcw-danger" onClick={() => void finishRecording(false)} aria-label={t('cancelRecording')} title={t('cancelRecording')}>
            <TrashIcon />
          </button>
          <div class="wcw-rec-status" role="status" aria-label={t('recording')}>
            <span class="wcw-rec-dot" />
            <span class="wcw-rec-time">{formatDuration(seconds)}</span>
            <span class="wcw-rec-bars" aria-hidden="true">
              {Array.from({ length: 10 }, (_, i) => (
                <i key={i} class={i < lit ? 'wcw-on' : ''} />
              ))}
            </span>
          </div>
          <button type="button" class="wcw-send" onClick={() => void finishRecording(true)} aria-label={t('stopAndSend')} title={t('stopAndSend')}>
            <SendIcon />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div class="wcw-composer-wrap">
      {emojiOpen && <EmojiPicker t={t} onPick={insertEmoji} />}
      <div class="wcw-composer">
        <button
          type="button"
          class="wcw-icon-btn"
          onClick={() => setEmojiOpen((v) => !v)}
          aria-label={t('emoji')}
          aria-pressed={emojiOpen}
          title={t('emoji')}
          disabled={disabled}
        >
          {emojiOpen ? <KeyboardIcon /> : <SmileIcon />}
        </button>
        <button
          type="button"
          class="wcw-icon-btn"
          onClick={() => fileRef.current?.click()}
          aria-label={t('attach')}
          title={t('attach')}
          disabled={disabled}
        >
          <PaperclipIcon />
        </button>
        <input
          ref={fileRef}
          type="file"
          class="wcw-hidden"
          accept={acceptAttribute(limits)}
          tabIndex={-1}
          onChange={(e) => {
            const input = e.target as HTMLInputElement
            const file = input.files?.[0]
            input.value = ''
            if (file) onFileChosen(file)
          }}
        />
        <textarea
          ref={inputRef}
          class="wcw-input"
          placeholder={t('typeMessage')}
          aria-label={t('typeMessage')}
          value={text}
          maxLength={MAX_TEXT}
          rows={1}
          disabled={disabled}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onFocus={() => setEmojiOpen(false)}
          onKeyDown={(e) => {
            // Phones: Enter is a newline (the send button sends). Desktop: Enter sends.
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouchPrimary()) {
              e.preventDefault()
              submitText()
            }
          }}
        />
        {hasText || !canRecord ? (
          <button
            type="button"
            class="wcw-send"
            disabled={!hasText || disabled}
            onClick={submitText}
            aria-label={t('send')}
            title={t('send')}
          >
            <SendIcon />
          </button>
        ) : (
          <button
            type="button"
            class="wcw-send"
            disabled={disabled || voice === 'starting'}
            onClick={() => void startRecording()}
            aria-label={t('voiceNote')}
            title={t('voiceNote')}
          >
            <MicIcon />
          </button>
        )}
      </div>
    </div>
  )
}
