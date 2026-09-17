// Plain CSS (no Tailwind) — the widget renders inside a Shadow DOM, so
// none of the host page's styles (and none of ours) leak either way.
// `--wcw-primary` is set inline per-mount from the account's branding.
export const WIDGET_CSS = `
:host, .wcw-root {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --wcw-primary: #3b82f6;
  --wcw-radius: 16px;
  /* The widget is a fixed light theme regardless of the host page or
     the visitor's OS setting. Without this, a browser in dark mode
     paints bare input/textarea elements with its own dark user-agent
     colors (dark background, light text) since the "all: initial"
     reset above resets properties, not the inherited color-scheme. */
  color-scheme: light;
}
.wcw-root * { box-sizing: border-box; }

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

.wcw-panel {
  position: fixed;
  bottom: 88px;
  width: 360px;
  max-width: calc(100vw - 32px);
  height: 520px;
  max-height: calc(100vh - 120px);
  background: #fff;
  border-radius: var(--wcw-radius);
  box-shadow: 0 12px 40px rgba(0,0,0,0.22);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 2147483000;
}
.wcw-panel.wcw-left { left: 20px; }
.wcw-panel.wcw-right { right: 20px; }

.wcw-header {
  background: var(--wcw-primary);
  color: #fff;
  padding: 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.wcw-header-avatar {
  width: 32px; height: 32px; border-radius: 999px;
  background: rgba(255,255,255,0.25);
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 600; overflow: hidden; flex-shrink: 0;
}
.wcw-header-avatar img { width: 100%; height: 100%; object-fit: cover; }
.wcw-header-title { font-size: 14px; font-weight: 600; flex: 1; min-width: 0; }
.wcw-close {
  background: none; border: none; color: #fff; cursor: pointer;
  width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
  opacity: 0.85; border-radius: 6px;
}
.wcw-close:hover { opacity: 1; background: rgba(255,255,255,0.15); }

.wcw-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #f4f5f7;
}

.wcw-welcome {
  background: #fff;
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 13px;
  color: #333;
  align-self: flex-start;
  max-width: 85%;
  box-shadow: 0 1px 2px rgba(0,0,0,0.06);
}

.wcw-bubble {
  max-width: 80%;
  padding: 8px 12px;
  border-radius: 14px;
  font-size: 13px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}
.wcw-bubble.wcw-customer {
  align-self: flex-end;
  background: var(--wcw-primary);
  color: #fff;
  border-bottom-right-radius: 4px;
}
.wcw-bubble.wcw-agent {
  align-self: flex-start;
  background: #fff;
  color: #222;
  border-bottom-left-radius: 4px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.06);
}
.wcw-bubble.wcw-pending { opacity: 0.6; }
.wcw-bubble.wcw-failed { background: #fee2e2; color: #991b1b; }

.wcw-empty {
  margin: auto;
  text-align: center;
  color: #8a8f98;
  font-size: 13px;
  padding: 24px;
}

.wcw-composer {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid #e6e7eb;
  background: #fff;
}
.wcw-input {
  flex: 1;
  resize: none;
  border: 1px solid #e0e1e6;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  max-height: 80px;
  min-height: 36px;
  outline: none;
  background: #fff;
  color: #222;
}
.wcw-input:focus { border-color: var(--wcw-primary); }
.wcw-send {
  width: 36px; height: 36px; border-radius: 10px;
  background: var(--wcw-primary);
  color: #fff; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.wcw-send:disabled { opacity: 0.5; cursor: default; }

.wcw-gate {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid #e6e7eb;
  background: #fff;
}
.wcw-gate-hint {
  font-size: 12px;
  color: #6b7280;
  margin: 0 0 2px;
}
.wcw-gate input {
  border: 1px solid #e0e1e6;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
  background: #fff;
  color: #222;
}
.wcw-gate input:focus { border-color: var(--wcw-primary); }
.wcw-gate-submit {
  border: none;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 13px;
  font-weight: 600;
  background: var(--wcw-primary);
  color: #fff;
  cursor: pointer;
}
.wcw-gate-submit:disabled { opacity: 0.5; cursor: default; }
.wcw-gate input::placeholder,
.wcw-input::placeholder {
  color: #9aa0ab;
}

.wcw-error {
  padding: 8px 12px;
  font-size: 12px;
  color: #991b1b;
  background: #fee2e2;
  text-align: center;
}
`
