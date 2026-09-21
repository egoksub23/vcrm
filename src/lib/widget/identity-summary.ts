// Picks the strongest identity among a contact's widget browsers.
// A contact can be reached from several browsers (a laptop, a phone), each
// with its own level; agents care about the best one proven.
import { IDENTITY_LEVEL_RANK, type IdentityLevel } from '@/lib/widget/identity-resolve'

export function strongestIdentity(
  visitors: { identity_level: string | null; identity_source: string | null }[],
): { level: IdentityLevel | null; source: string | null } {
  let best: { level: IdentityLevel; source: string | null } | null = null
  for (const v of visitors) {
    const level = (v.identity_level ?? 'guest') as IdentityLevel
    if (!(level in IDENTITY_LEVEL_RANK)) continue
    if (!best || IDENTITY_LEVEL_RANK[level] > IDENTITY_LEVEL_RANK[best.level]) {
      best = { level, source: v.identity_source }
    }
  }
  return best ?? { level: null, source: null }
}
