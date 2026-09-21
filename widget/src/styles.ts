// Plain CSS (no Tailwind) — the widget renders inside a Shadow DOM, so
// none of the host page's styles (and none of ours) leak either way.
// `--wcw-primary` is set inline per-mount from the account's branding.
export const WIDGET_CSS = `
:host, .wcw-root {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Noto Sans", "Noto Sans SC", sans-serif;
  --wcw-primary: #3b82f6;
  --wcw-radius: 16px;
  --wcw-text: #111b21;
  --wcw-muted: #667781;
  --wcw-tick-read: #53bdeb;
  --wcw-chat-bg: #efeae2;
  --wcw-me: #d9fdd3;
  --wcw-me: color-mix(in srgb, var(--wcw-primary) 18%, #ffffff);
  /* The widget is a fixed light theme regardless of the host page or
     the visitor's OS setting. Without this, a browser in dark mode
     paints bare input/textarea elements with its own dark user-agent
     colors (dark background, light text) since the "all: initial"
     reset above resets properties, not the inherited color-scheme. */
  color-scheme: light;
}
.wcw-root * { box-sizing: border-box; }
:where(.wcw-root) :where(button, input, textarea, select) { font: inherit; color: inherit; }
.wcw-root .wcw-hidden { display: none !important; }

/* ---------- launcher ---------- */
.wcw-launcher {
  position: fixed;
  bottom: 20px;
  width: 56px;
  height: 56px;
  border-radius: 999px;
  background: var(--wcw-primary);
  color: #fff;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 24px rgba(0,0,0,0.2);
  z-index: 2147483000;
  transition: transform 0.15s ease;
}
.wcw-launcher:hover { transform: scale(1.06); }
.wcw-launcher.wcw-left { left: 20px; }
.wcw-launcher.wcw-right { right: 20px; }
.wcw-badge {
  position: absolute;
  top: -4px; right: -4px;
  min-width: 20px; height: 20px;
  padding: 0 5px;
  border-radius: 999px;
  background: #ef4444;
  color: #fff;
  font-size: 11px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  border: 2px solid #fff;
}

/* ---------- panel ---------- */
.wcw-panel {
  position: fixed;
  bottom: 88px;
  width: 380px;
  max-width: calc(100vw - 32px);
  height: 640px;
  max-height: calc(100vh - 110px);
  background: #fff;
  border-radius: var(--wcw-radius);
  box-shadow: 0 12px 40px rgba(0,0,0,0.22);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 2147483000;
  color: var(--wcw-text);
  font-size: 14px;
  line-height: 1.4;
}
.wcw-panel.wcw-left { left: 20px; }
.wcw-panel.wcw-right { right: 20px; }

/* Phones: the panel is the whole screen (JS also tracks the visual
   viewport so the keyboard never covers the composer). */
.wcw-panel.wcw-mobile,
.wcw-panel.wcw-mobile.wcw-left,
.wcw-panel.wcw-mobile.wcw-right {
  left: 0; right: 0; top: 0; bottom: auto;
  width: 100%;
  max-width: none;
  height: 100vh;
  height: 100dvh;
  max-height: none;
  border-radius: 0;
  box-shadow: none;
}

/* ---------- header ---------- */
.wcw-header {
  background: var(--wcw-primary);
  color: #fff;
  padding: 10px 8px 10px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding-top: max(10px, env(safe-area-inset-top));
}
.wcw-header-avatar {
  width: 38px; height: 38px; border-radius: 999px;
  background: rgba(255,255,255,0.25);
  display: flex; align-items: center; justify-content: center;
  font-size: 15px; font-weight: 600; overflow: hidden; flex-shrink: 0;
}
.wcw-header-avatar img { width: 100%; height: 100%; object-fit: cover; }
.wcw-header-text { flex: 1; min-width: 0; }
.wcw-header-title { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wcw-header-sub { font-size: 11px; opacity: 0.85; }
.wcw-close {
  background: none; border: none; color: #fff; cursor: pointer;
  width: 36px; height: 36px; display: flex; align-items: center; justify-content: center;
  opacity: 0.9; border-radius: 999px; flex-shrink: 0;
}
.wcw-close:hover { opacity: 1; background: rgba(255,255,255,0.15); }

/* ---------- banner ---------- */
.wcw-banner {
  padding: 8px 12px;
  font-size: 12px;
  text-align: center;
  cursor: pointer;
  flex-shrink: 0;
}
.wcw-banner-error { color: #991b1b; background: #fee2e2; }
.wcw-banner-info { color: #14532d; background: #dcfce7; }

/* ---------- body / list ---------- */
.wcw-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: #f4f5f7;
}
.wcw-body-chat { background: var(--wcw-chat-bg); }

.wcw-welcome {
  background: #fff;
  border-radius: 12px;
  padding: 9px 12px;
  font-size: 13px;
  color: var(--wcw-text);
  align-self: flex-start;
  max-width: 85%;
  box-shadow: 0 1px 1px rgba(11,20,26,0.1);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.wcw-empty {
  margin: auto;
  text-align: center;
  color: #8a8f98;
  font-size: 13px;
  padding: 24px;
  display: flex; flex-direction: column; align-items: center; gap: 12px;
}
.wcw-empty p { margin: 0; }
.wcw-empty-inline { margin: 12px auto; padding: 8px; }
.wcw-history-error {
  align-self: center; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center;
  margin: 8px 0; padding: 8px 12px; border-radius: 10px; font-size: 12.5px;
  color: #991b1b; background: #fee2e2;
}
.wcw-history-error .wcw-linkbtn { color: #991b1b; font-weight: 600; text-decoration: underline; }

.wcw-day, .wcw-unread {
  align-self: center;
  margin: 8px 0 4px;
  font-size: 11.5px;
  color: #54656f;
}
.wcw-day span {
  background: #fff;
  border-radius: 8px;
  padding: 4px 10px;
  box-shadow: 0 1px 1px rgba(11,20,26,0.1);
}
.wcw-unread { align-self: stretch; text-align: center; }
.wcw-unread span {
  display: inline-block;
  background: #e1f2fb;
  color: #3b4a54;
  border-radius: 8px;
  padding: 4px 12px;
}
.wcw-earlier { align-self: center; padding: 6px 12px; }

.wcw-row { display: flex; flex-direction: column; }
.wcw-row-me { align-items: flex-end; }
.wcw-row-them { align-items: flex-start; }

.wcw-bubble {
  position: relative;
  max-width: 82%;
  padding: 6px 9px 6px 9px;
  border-radius: 10px;
  font-size: 14px;
  line-height: 1.35;
  overflow-wrap: anywhere;
  box-shadow: 0 1px 1px rgba(11,20,26,0.13);
}
.wcw-bubble.wcw-customer {
  background: var(--wcw-me);
  color: var(--wcw-text);
  border-top-right-radius: 3px;
}
.wcw-bubble.wcw-agent {
  background: #fff;
  color: var(--wcw-text);
  border-top-left-radius: 3px;
}
.wcw-bubble.wcw-pending { opacity: 0.85; }
.wcw-bubble.wcw-failed { background: #fee2e2; }
.wcw-failed-note { font-size: 11px; color: #b91c1c; margin-top: 2px; cursor: pointer; }
.wcw-row[role="button"] { cursor: pointer; }

.wcw-text { white-space: pre-wrap; }
.wcw-link { color: #027eb5; text-decoration: underline; }

.wcw-meta {
  float: right;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin: 7px 0 -3px 10px;
  font-size: 11px;
  line-height: 1;
  color: var(--wcw-muted);
  white-space: nowrap;
  user-select: none;
}
.wcw-tick { display: inline-flex; color: #8696a0; }
.wcw-tick-read { color: var(--wcw-tick-read); }
.wcw-tick-pending { color: #8696a0; }
.wcw-tick-failed { color: #dc2626; }
.wcw-bubble::after { content: ""; display: block; clear: both; }

/* media */
.wcw-has-media { padding: 3px; }
.wcw-has-media .wcw-text { padding: 4px 6px 0; }
.wcw-has-media .wcw-meta { margin-right: 4px; }
.wcw-media {
  display: block;
  position: relative;
  border: none; padding: 0; margin: 0;
  background: none;
  border-radius: 8px;
  overflow: hidden;
  max-width: 100%;
}
.wcw-media-btn { cursor: zoom-in; }
.wcw-media img, .wcw-media video {
  display: block;
  max-width: 100%;
  max-height: 260px;
  min-width: 120px;
  width: auto;
  height: auto;
  background: #0b141a10;
}
.wcw-media-only .wcw-meta {
  position: absolute;
  right: 8px; bottom: 7px;
  margin: 0;
  float: none;
  color: #fff;
  background: rgba(0,0,0,0.42);
  border-radius: 10px;
  padding: 3px 6px;
}
.wcw-media-only .wcw-tick { color: #e9edef; }
.wcw-media-only .wcw-tick-read { color: var(--wcw-tick-read); }
.wcw-media-only .wcw-time { color: #fff; }

.wcw-spinner {
  position: absolute; top: 50%; left: 50%;
  width: 30px; height: 30px; margin: -15px 0 0 -15px;
  border: 3px solid rgba(255,255,255,0.5);
  border-top-color: #fff;
  border-radius: 999px;
  animation: wcw-spin 0.8s linear infinite;
  background: rgba(0,0,0,0.25);
}
.wcw-spinner-inline {
  position: static; margin: 0; width: 20px; height: 20px; flex-shrink: 0;
  border-color: rgba(0,0,0,0.15); border-top-color: var(--wcw-primary); background: none;
}
@keyframes wcw-spin { to { transform: rotate(360deg); } }

.wcw-file {
  display: flex; align-items: center; gap: 10px;
  min-width: 200px;
  padding: 8px 10px;
  background: rgba(11,20,26,0.06);
  border-radius: 8px;
  color: inherit;
  text-decoration: none;
  cursor: pointer;
}
.wcw-file-icon { display: flex; color: var(--wcw-primary); }
.wcw-file-body { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.wcw-file-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px; }
.wcw-file-size { font-size: 11px; color: var(--wcw-muted); }

.wcw-audio { display: flex; align-items: center; gap: 8px; min-width: 210px; padding: 2px 4px; }
.wcw-audio-btn {
  width: 34px; height: 34px; border-radius: 999px; flex-shrink: 0;
  border: none; cursor: pointer;
  background: var(--wcw-primary); color: #fff;
  display: flex; align-items: center; justify-content: center;
}
.wcw-audio-bar { flex: 1; min-width: 0; height: 4px; accent-color: var(--wcw-primary); cursor: pointer; }
.wcw-audio-time { font-size: 11px; color: var(--wcw-muted); min-width: 32px; text-align: right; }

/* ---------- composer ---------- */
.wcw-composer-wrap { flex-shrink: 0; background: #f0f2f5; }
.wcw-composer {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 4px;
  padding: 8px;
  padding-bottom: max(8px, env(safe-area-inset-bottom));
  background: #f0f2f5;
}
.wcw-composer-rec { align-items: center; }
.wcw-icon-btn {
  width: 38px; height: 38px; border-radius: 999px; flex-shrink: 0;
  border: none; background: none; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  color: #54656f;
  text-decoration: none;
}
.wcw-icon-btn:hover:not(:disabled) { background: rgba(11,20,26,0.07); }
.wcw-icon-btn:disabled { opacity: 0.4; cursor: default; }
.wcw-icon-btn.wcw-danger { color: #dc2626; }
.wcw-icon-btn.wcw-on-dark { color: #fff; }
.wcw-icon-btn.wcw-on-dark:hover { background: rgba(255,255,255,0.15); }
.wcw-input {
  flex: 1;
  min-width: 0;
  resize: none;
  border: none;
  border-radius: 20px;
  padding: 9px 14px;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.35;
  max-height: 110px;
  min-height: 38px;
  outline: none;
  background: #fff;
  color: var(--wcw-text);
}
.wcw-input::placeholder, .wcw-caption::placeholder { color: #8696a0; }
.wcw-send {
  width: 40px; height: 40px; border-radius: 999px;
  background: var(--wcw-primary);
  color: #fff; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.wcw-send:disabled { opacity: 0.5; cursor: default; }

.wcw-rec-status {
  flex: 1; display: flex; align-items: center; gap: 10px;
  background: #fff; border-radius: 20px; padding: 0 14px; height: 38px;
  color: var(--wcw-text);
}
.wcw-rec-dot { width: 10px; height: 10px; border-radius: 999px; background: #ef4444; animation: wcw-pulse 1.1s ease-in-out infinite; }
.wcw-rec-time { font-variant-numeric: tabular-nums; font-size: 14px; min-width: 38px; }
.wcw-rec-bars { display: inline-flex; align-items: center; gap: 3px; height: 20px; }
.wcw-rec-bars i { display: block; width: 3px; height: 6px; border-radius: 2px; background: #cfd4d8; transition: height 0.1s, background 0.1s; }
.wcw-rec-bars i.wcw-on { height: 16px; background: var(--wcw-primary); }
@keyframes wcw-pulse { 50% { opacity: 0.3; } }
.wcw-mic-hint {
  padding: 8px 12px 0; font-size: 12.5px; color: #92400e; background: #fffbeb;
  border-top: 1px solid #fde68a; display: flex; flex-direction: column; gap: 4px;
}
.wcw-mic-actions { display: flex; gap: 12px; flex-wrap: wrap; padding-bottom: 6px; }
.wcw-mic-actions .wcw-linkbtn { padding: 2px 0; }
.wcw-strong { font-weight: 600; }
.wcw-mic-list { display: flex; flex-direction: column; max-height: 132px; overflow-y: auto; padding-bottom: 6px; }
.wcw-mic-opt {
  text-align: left; border: none; background: none; cursor: pointer; font: inherit; font-size: 12.5px;
  color: var(--wcw-text); padding: 6px 8px; border-radius: 8px; overflow-wrap: anywhere;
}
.wcw-mic-opt:hover { background: rgba(11,20,26,0.06); }
.wcw-mic-opt.wcw-on { font-weight: 600; background: var(--wcw-me); }
.wcw-mic-none { color: #54656f; padding: 4px 8px; }

/* ---------- emoji ---------- */
.wcw-emoji {
  height: 220px;
  display: flex; flex-direction: column;
  background: #fff;
  border-top: 1px solid #e6e7eb;
}
.wcw-emoji-msg { margin: auto; color: #8a8f98; font-size: 13px; padding: 16px; text-align: center; grid-column: 1 / -1; }
.wcw-emoji-search {
  display: flex; align-items: center; gap: 6px;
  margin: 8px 8px 4px; padding: 0 10px; height: 34px;
  background: #f0f2f5; border-radius: 17px; color: #54656f;
}
.wcw-emoji-search input { flex: 1; min-width: 0; border: none; background: none; outline: none; font-size: 14px; }
.wcw-emoji-tabs { display: flex; gap: 2px; padding: 2px 6px; overflow-x: auto; flex-shrink: 0; border-bottom: 1px solid #f0f2f5; }
.wcw-emoji-tabs button {
  flex: 0 0 auto; width: 34px; height: 32px; border: none; background: none; cursor: pointer;
  font-size: 18px; border-radius: 8px; opacity: 0.55; border-bottom: 2px solid transparent;
}
.wcw-emoji-tabs button.wcw-on { opacity: 1; border-bottom-color: var(--wcw-primary); }
.wcw-emoji-grid {
  flex: 1; min-height: 0; overflow-y: auto;
  display: grid; grid-template-columns: repeat(8, 1fr);
  align-content: start;
  padding: 4px 6px 8px;
}
.wcw-emoji-btn {
  border: none; background: none; cursor: pointer;
  font-size: 22px; line-height: 1; height: 38px; border-radius: 8px;
  font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
}
.wcw-emoji-btn:hover { background: #f0f2f5; }

/* ---------- link-your-account strip ---------- */
.wcw-link-account {
  flex-shrink: 0;
  display: flex; justify-content: center;
  padding: 6px 10px;
  border-top: 1px solid #e6e7eb;
  background: #f9fafb;
}
.wcw-linkbtn {
  border: none; background: none; cursor: pointer;
  color: var(--wcw-primary); font-size: 12.5px; padding: 4px;
  text-decoration: underline;
}
.wcw-linkbtn:disabled { opacity: 0.5; cursor: default; }

/* ---------- pre-chat screens / forms ---------- */
.wcw-screen { display: flex; flex-direction: column; gap: 10px; padding: 4px 0 8px; }
.wcw-screen-title { margin: 8px 0 0; font-size: 17px; font-weight: 700; color: var(--wcw-text); }
.wcw-screen-hint { margin: 0; font-size: 13px; color: var(--wcw-muted); }
.wcw-choice {
  display: flex; flex-direction: column; gap: 2px; text-align: left;
  border: 1px solid #dfe3e7; background: #fff; border-radius: 12px;
  padding: 12px 14px; cursor: pointer;
}
.wcw-choice:hover:not(:disabled) { border-color: var(--wcw-primary); }
.wcw-choice:disabled { opacity: 0.6; cursor: default; }
.wcw-choice-title { font-size: 14px; font-weight: 600; color: var(--wcw-text); }
.wcw-choice-hint { font-size: 12px; color: var(--wcw-muted); }
.wcw-field { display: flex; flex-direction: column; gap: 4px; border: none; margin: 0; padding: 0; min-width: 0; }
.wcw-field > span, .wcw-field > legend { font-size: 12px; font-weight: 600; color: #3b4a54; padding: 0; }
.wcw-field input[type="text"], .wcw-field input[type="tel"], .wcw-field input[type="email"], .wcw-field textarea {
  width: 100%;
  border: 1px solid #d5dade; border-radius: 10px;
  padding: 9px 11px; font-size: 14px; outline: none;
  background: #fff; color: var(--wcw-text);
  font-family: inherit;
}
.wcw-field textarea { resize: vertical; min-height: 84px; }
.wcw-field input:focus, .wcw-field textarea:focus { border-color: var(--wcw-primary); }
.wcw-field-note { margin: -4px 0 0; font-size: 11.5px; color: var(--wcw-muted); }
.wcw-role-row { display: flex; flex-wrap: wrap; gap: 6px; }
.wcw-chip {
  display: inline-flex; align-items: center;
  border: 1px solid #d5dade; border-radius: 999px; padding: 6px 12px;
  font-size: 13px; cursor: pointer; background: #fff; color: #3b4a54;
}
.wcw-chip input { position: absolute; opacity: 0; width: 0; height: 0; }
.wcw-chip.wcw-on { border-color: var(--wcw-primary); background: var(--wcw-me); color: var(--wcw-text); font-weight: 600; }
.wcw-consent { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; color: #3b4a54; cursor: pointer; }
.wcw-consent input { margin-top: 2px; accent-color: var(--wcw-primary); width: 16px; height: 16px; flex-shrink: 0; }
.wcw-form-error { margin: 0; font-size: 12.5px; color: #b91c1c; }
.wcw-primary {
  border: none; border-radius: 10px; padding: 10px 12px;
  font-size: 14px; font-weight: 600;
  background: var(--wcw-primary); color: #fff; cursor: pointer;
}
.wcw-primary:disabled { opacity: 0.6; cursor: default; }

/* ---------- overlays ---------- */
.wcw-overlay {
  position: absolute; inset: 0; z-index: 5;
  display: flex; flex-direction: column;
  background: #0b141a; color: #fff;
}
.wcw-overlay-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px; padding-top: max(8px, env(safe-area-inset-top));
  flex-shrink: 0;
}
.wcw-overlay-name { flex: 1; min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wcw-preview-stage {
  flex: 1; min-height: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 8px;
}
.wcw-preview-stage img, .wcw-preview-stage video { max-width: 100%; max-height: 100%; object-fit: contain; }
.wcw-preview-file { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; color: #e9edef; }
.wcw-preview-file svg { width: 56px; height: 56px; }
.wcw-preview-file-name { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; padding: 0 16px; }
.wcw-preview-file-size { font-size: 12px; opacity: 0.7; }
.wcw-preview-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px; padding-bottom: max(8px, env(safe-area-inset-bottom));
  background: #111b21;
}
.wcw-caption {
  flex: 1; min-width: 0;
  border: none; outline: none; border-radius: 20px;
  padding: 10px 14px; font-size: 14px;
  background: #2a3942; color: #e9edef;
}
.wcw-jump {
  position: absolute; right: 14px; bottom: 74px; z-index: 3;
  width: 36px; height: 36px; border-radius: 999px;
  border: none; cursor: pointer; background: #fff; color: #54656f;
  box-shadow: 0 2px 8px rgba(0,0,0,0.25);
  display: flex; align-items: center; justify-content: center;
}

/* iOS zooms into inputs below 16px; keep them at 16px on phones. */
.wcw-mobile .wcw-input,
.wcw-mobile .wcw-caption,
.wcw-mobile .wcw-field input,
.wcw-mobile .wcw-field textarea,
.wcw-mobile .wcw-emoji-search input { font-size: 16px; }

@media (prefers-reduced-motion: reduce) {
  .wcw-launcher, .wcw-rec-dot, .wcw-spinner { transition: none; animation: none; }
}
`
