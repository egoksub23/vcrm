// ============================================================
// Widget loader entry point. Bundled by esbuild (see
// scripts/build-widget.mjs) into a single classic IIFE script,
// public/widget/loader.js — embedded as:
//
//   <script src="https://<host>/widget/loader.js"
//           data-widget-token="wt_..." async></script>
//
// An optional `data-open="true"` attribute starts the panel already
// open instead of collapsed to the launcher bubble — used by the
// Settings → Channels → Web Widget "Test chat" link
// (src/app/widget-preview/page.tsx) so clicking it drops the tester
// straight into a live conversation rather than requiring an extra
// click on a page that has nothing else on it.
//
// Reads its own <script> tag's data attribute (must happen here, at
// synchronous top-level module-evaluation time — see the comment in
// api.ts on why `document.currentScript` can't be read lazily), mounts
// a Shadow DOM container so none of the host page's CSS can leak in or
// out, and renders the Preact chat app inside it.
// ============================================================
import { render } from 'preact'
import { App } from './App'
import { WIDGET_CSS } from './styles'

declare global {
  interface Window {
    __vircleWidgetMounted?: boolean
  }
}

// Captured synchronously, at module-evaluation time — `document
// .currentScript` is null by the time DOMContentLoaded fires below,
// so it cannot be read lazily inside `mount()`.
const loaderScript = document.currentScript as HTMLScriptElement | null

function mount() {
  if (window.__vircleWidgetMounted) return
  window.__vircleWidgetMounted = true

  const widgetToken = loaderScript?.dataset.widgetToken
  if (!widgetToken) {
    console.error('[vircle-widget] missing data-widget-token on the loader <script> tag')
    return
  }

  const host = document.createElement('div')
  host.id = 'vircle-chat-widget'
  document.body.appendChild(host)

  const shadow = host.attachShadow({ mode: 'open' })
  const styleEl = document.createElement('style')
  styleEl.textContent = WIDGET_CSS
  shadow.appendChild(styleEl)

  const mountPoint = document.createElement('div')
  shadow.appendChild(mountPoint)

  const autoOpen = loaderScript?.dataset.open === 'true'
  render(<App widgetToken={widgetToken} autoOpen={autoOpen} />, mountPoint)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount)
} else {
  mount()
}
