// ============================================================
// The link behind "Open simulator" in Settings, Channels, Vircle Chat.
//
// The simulator is a page served by the gateway (gateway/public, docs/vircle-chat-gateway-scope.md,
// section 4). It lets anyone with `channels.manage` try the chat without the app: a pretend phone,
// the alerts the gateway raised, the calls to Halo, and fault buttons.
//
// The gateway must know the person is a signed-in Halo admin of this workspace. Halo proves it with a
// launch token signed by the workspace's webhook signing secret, which only Halo and the gateway hold:
//
//   <payload>.<signature>
//   payload    base64url of {"k": "<workspace key>", "exp": <unix seconds>, "n": "<nonce>"}
//   signature  hex HMAC-SHA256(signing secret, "vircle-sim." + payload)
//
// It lives five minutes and the gateway accepts it once. It goes in the URL FRAGMENT (after `#`), which
// browsers never send to a server, so it is not in any access log. Same algorithm as
// gateway/src/simulator/token.ts; gateway/test/contract-halo.test.ts checks the two agree.
// ============================================================

import { createHmac, randomBytes } from 'node:crypto'

export const LAUNCH_TOKEN_TTL_SECONDS = 300

export function createLaunchToken(signingSecret: string, workspaceKey: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const payload = Buffer.from(
    JSON.stringify({ k: workspaceKey, exp: nowSeconds + LAUNCH_TOKEN_TTL_SECONDS, n: randomBytes(12).toString('base64url') }),
  ).toString('base64url')
  const signature = createHmac('sha256', signingSecret).update(`vircle-sim.${payload}`).digest('hex')
  return `${payload}.${signature}`
}

/** The address to open: the gateway's simulator page with the launch token in the fragment. */
export function simulatorUrl(gatewayBaseUrl: string, signingSecret: string, workspaceKey: string, nowSeconds?: number): string {
  return `${gatewayBaseUrl.replace(/\/+$/, '')}/simulator#t=${createLaunchToken(signingSecret, workspaceKey, nowSeconds)}`
}
