// ============================================================
// Widget loader entry point. Bundled by esbuild (see
// scripts/build-widget.mjs) into a single classic IIFE script,
// public/widget/loader.js — embedded as:
//
//   <script src="https://<host>/widget/loader.js"
//           data-widget-token="wt_..." async></script>
//
// Optional attributes on that tag:
//   data-open="true"            start with the panel open (Settings -> Web Widget "Test chat").
//   data-lang="en|ms|zh"        widget language; else <html lang>, else the browser language.
//   data-identity-token="..."   in-app identity signed by YOUR backend (verified — see
//                               docs/web-chat-widget.md). Also settable later with
//                               window.VircleWidget.identify({ token }).
//   data-user-phone / data-user-email / data-user-wallet-id / data-user-name
//                               LEGACY unsigned hints. Still accepted, but the server now
//                               treats them as an UNVERIFIED claim.
//
// Reads its own <script> tag's data attributes (must happen here, at
// synchronous top-level module-evaluation time — see the comment in
// api.ts on why `document.currentScript` can't be read lazily), mounts
// a Shadow DOM container so none of the host page's CSS can leak in or
// out, and renders the Preact chat app inside it.
// ============================================================
import { render } from 'preact'
import { App } from './App'
import { makeTranslator, resolveLocale } from './i18n'
import { WIDGET_CSS } from './styles'
import type { IdentityInput } from './types'
import { Guard } from './ui/Guard'

declare global {
  interface Window {
    __vircleWidgetMounted?: boolean
    /**
     * Async handoff for a host app whose own sign-in finishes AFTER
     * this script has already loaded and mounted (the common WebView
     * shape: the wrapper injects the widget script early, then calls
     * identify() once its own auth resolves). If identify() is called
     * before the widget has mounted its listener, the call is queued
     * and delivered as soon as it's ready — no race on load order.
     *
     * `{ token }` is the signed in-app identity (verified). `{ phone,
     * email, name }` still work but count as an unverified claim.
     */
    VircleWidget?: { identify: (identity: IdentityInput) => void }
  }
}

let identifyListener: ((identity: IdentityInput) => void) | null = null
let queuedIdentify: IdentityInput | null = null

window.VircleWidget = {
  identify(identity: IdentityInput) {
    if (!identity || typeof identity !== 'object') return
    if (identifyListener) identifyListener(identity)
    else queuedIdentify = { ...queuedIdentify, ...identity }
  },
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
  const locale = resolveLocale(
    loaderScript?.dataset.lang,
    document.documentElement.lang,
    navigator.languages?.length ? navigator.languages : [navigator.language],
  )

  // Optional synchronous handoff (the loader tag's own data-* attrs) —
  // the common shape when the host already knows the user BEFORE it
  // injects this script (it finished its own login, then set these
  // when appending the tag). The async window.VircleWidget.identify()
  // path above covers the case where that isn't possible.
  const ds = loaderScript?.dataset
  const initialIdentity: IdentityInput = {
    token: ds?.identityToken || undefined,
    phone: ds?.userPhone || undefined,
    email: ds?.userEmail || undefined,
    walletId: ds?.userWalletId || undefined,
    name: ds?.userName || undefined,
  }

  const t = makeTranslator(locale)
  // If anything in the chat ever throws while rendering, show a message with a retry
  // (which mounts the app afresh and reloads the history) instead of a blank widget.
  render(
    <Guard
      fallback={(reset) => (
        <div class="wcw-root" lang={locale}>
          <div class="wcw-panel wcw-right">
            <div class="wcw-header">
              <div class="wcw-header-text">
                <div class="wcw-header-title">Chat</div>
              </div>
            </div>
            <div class="wcw-body">
              <div class="wcw-empty" role="alert">
                <p>{t('chatCrashed')}</p>
                <button type="button" class="wcw-primary" onClick={reset}>
                  {t('retry')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    >
      <App
        widgetToken={widgetToken}
        locale={locale}
        autoOpen={autoOpen}
        initialIdentity={initialIdentity}
        onIdentifyReady={(cb) => {
          identifyListener = cb
          if (queuedIdentify) {
            cb(queuedIdentify)
            queuedIdentify = null
          }
        }}
      />
    </Guard>,
    mountPoint,
  )
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount)
} else {
  mount()
}
