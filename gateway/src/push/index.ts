import type { GatewayConfig } from './../config'
import type { PushAdapter } from './adapter'
import { MockPushAdapter } from './mock'
import { VirclePushAdapter } from './vircle'

export type { PushAdapter, PushRequest, PushResult } from './adapter'
export { CHAT_ALERT_FIELD, NOTIFICATION_TYPE, chatAlertData } from './adapter'
export { MockPushAdapter } from './mock'
export { VirclePushAdapter, type VirclePushOptions } from './vircle'

/** The adapter named by PUSH_ADAPTER: `mock` records alerts and sends nothing; `vircle` calls the Vircle send-mobile-alert API (work package 8). */
export function createPushAdapter(cfg: Pick<GatewayConfig, 'push'>): PushAdapter {
  switch (cfg.push.adapter) {
    case 'mock':
      return new MockPushAdapter()
    case 'vircle': {
      const { url, key, stage, sendData, timeoutMs } = cfg.push.api
      if (!url || !key || !stage) throw new Error('PUSH_ADAPTER=vircle needs PUSH_API_URL, PUSH_API_KEY and PUSH_API_STAGE')
      return new VirclePushAdapter({ url, apiKey: key, stage, sendData, timeoutMs })
    }
  }
}
