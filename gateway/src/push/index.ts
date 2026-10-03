import type { GatewayConfig } from './../config'
import type { PushAdapter } from './adapter'
import { MockPushAdapter } from './mock'

export type { PushAdapter, PushRequest, PushResult } from './adapter'
export { MockPushAdapter } from './mock'

/** The adapter named by PUSH_ADAPTER. The real one arrives with work package 8, when the push API's details are known. */
export function createPushAdapter(cfg: Pick<GatewayConfig, 'push'>): PushAdapter {
  switch (cfg.push.adapter) {
    case 'mock':
      return new MockPushAdapter()
    case 'vircle':
      throw new Error('PUSH_ADAPTER=vircle is not available yet: it needs the Vircle push API details (work package 8). Use PUSH_ADAPTER=mock.')
  }
}
