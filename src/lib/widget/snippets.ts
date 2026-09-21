// ============================================================
// Web Widget v2 — copy-paste server snippets for signing an in-app
// identity token (shown in Settings, Channels, Web Widget, and in
// docs/web-chat-widget.md). They implement the token format documented in
// src/lib/widget/identity-token.ts. The Node one is executed by a unit
// test against `verifyIdentityToken`, so the docs cannot drift from the
// verifier.
// ============================================================

export type SnippetLanguage = 'node' | 'php' | 'python'

export const IDENTITY_SNIPPET_LANGUAGES: readonly SnippetLanguage[] = ['node', 'php', 'python']

export const NODE_IDENTITY_SNIPPET = `import crypto from 'node:crypto'

// Keep the secret on your server only (an environment variable), never in the page.
const SECRET = process.env.VIRCLE_WIDGET_SECRET

export function widgetIdentityToken(user) {
  const payload = {
    phone: user.phone,      // e.g. "+60123980112"
    email: user.email,
    walletId: user.walletId,
    name: user.name,
    iat: Math.floor(Date.now() / 1000),
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  return body + '.' + sig
}`

export const PHP_IDENTITY_SNIPPET = `<?php
// Keep the secret on your server only (an environment variable), never in the page.
function widget_identity_token(array $user): string {
    $b64 = fn(string $raw): string => rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    $payload = array_filter([
        'phone'    => $user['phone'] ?? null,   // e.g. "+60123980112"
        'email'    => $user['email'] ?? null,
        'walletId' => $user['walletId'] ?? null,
        'name'     => $user['name'] ?? null,
    ], fn($v) => $v !== null && $v !== '');
    $payload['iat'] = time();
    $body = $b64(json_encode($payload));
    $sig  = $b64(hash_hmac('sha256', $body, getenv('VIRCLE_WIDGET_SECRET'), true));
    return $body . '.' . $sig;
}`

export const PYTHON_IDENTITY_SNIPPET = `import base64, hashlib, hmac, json, os, time

# Keep the secret on your server only (an environment variable), never in the page.
SECRET = os.environ["VIRCLE_WIDGET_SECRET"].encode()

def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

def widget_identity_token(user: dict) -> str:
    payload = {
        "phone": user.get("phone"),        # e.g. "+60123980112"
        "email": user.get("email"),
        "walletId": user.get("walletId"),
        "name": user.get("name"),
    }
    payload = {k: v for k, v in payload.items() if v}
    payload["iat"] = int(time.time())
    body = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = _b64url(hmac.new(SECRET, body.encode(), hashlib.sha256).digest())
    return body + "." + sig`

export const IDENTITY_SNIPPETS: Record<SnippetLanguage, string> = {
  node: NODE_IDENTITY_SNIPPET,
  php: PHP_IDENTITY_SNIPPET,
  python: PYTHON_IDENTITY_SNIPPET,
}

/** The embed tag, with the token your server signed for the signed-in user rendered into the page. */
export function embedWithTokenSnippet(origin: string, widgetToken: string): string {
  return `<script src="${origin}/widget/loader.js"
        data-widget-token="${widgetToken}"
        data-identity-token="TOKEN_SIGNED_BY_YOUR_SERVER"
        async></script>`
}

/** Late handoff, for a host whose sign-in finishes after the script loaded. */
export const IDENTIFY_LATE_SNIPPET = `// After your own sign-in completes (fetch a fresh token from your server first):
window.VircleWidget.identify({ token: tokenFromYourServer })`
