// ============================================================
// /api/sembang/directory
//
//   GET — everyone in the account who currently HOLDS the
//         `menu.sembang` capability (not just people who happen to
//         share a channel with the caller). Reuses the established
//         "who in this account holds capability X" pattern
//         (`src/lib/auth/capability-recipients.ts`, also used by
//         `src/lib/tickets/comment-write.ts`, `src/app/api/sla/cron/route.ts`,
//         `src/lib/ai/budget.ts`) READ-ONLY — that module only returns
//         user ids, so the profile fields (name/avatar/role) a directory
//         needs are queried directly here rather than via a second
//         per-id round trip: `profiles` filtered to the account and to
//         `candidateRoles('menu.sembang')` (narrows which roles could
//         ever hold it) is queried ONCE with every column the directory
//         needs, then `role_capabilities` overrides, then
//         `selectCapabilityRecipients` picks the actual held-it subset.
//
// Returns `{ members: SembangDirectoryMember[] }`, sorted by fullName.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import {
  candidateRoles,
  selectCapabilityRecipients,
  type RecipientMember,
  type RoleOverrideRow,
} from '@/lib/auth/capability-recipients'
import type { SembangDirectoryMember } from '@/types'

const CAPABILITY = 'menu.sembang'

interface ProfileRow {
  user_id: string
  full_name: string | null
  avatar_url: string | null
  account_role: string
}

export async function GET() {
  try {
    const ctx = await requireCapability(CAPABILITY)

    const candidates = candidateRoles(CAPABILITY)
    if (candidates.length === 0) {
      return NextResponse.json({ members: [] })
    }

    const [{ data: profileRows, error: profileErr }, { data: overrideRows, error: overrideErr }] =
      await Promise.all([
        ctx.supabase
          .from('profiles')
          .select('user_id, full_name, avatar_url, account_role')
          .eq('account_id', ctx.accountId)
          .in('account_role', candidates),
        ctx.supabase
          .from('role_capabilities')
          .select('role, capability, granted')
          .eq('account_id', ctx.accountId)
          .eq('capability', CAPABILITY)
          .in(
            'role',
            candidates.filter((r) => r !== 'owner'),
          ),
      ])

    if (profileErr) {
      console.error('[GET /api/sembang/directory] profiles fetch error:', profileErr)
      return NextResponse.json({ error: 'Failed to load directory' }, { status: 500 })
    }
    if (overrideErr) {
      // Unlike `loadCapabilityRecipients` (used for best-effort
      // notifications, which fails open to defaults), a directory listing
      // is itself access-sensitive — fail closed rather than risk
      // silently widening who appears, same posture as `loadCapabilities`
      // in `@/lib/auth/account`.
      console.error('[GET /api/sembang/directory] role_capabilities fetch error:', overrideErr)
      return NextResponse.json({ error: 'Failed to load directory' }, { status: 500 })
    }

    const rows = (profileRows ?? []) as ProfileRow[]
    const recipientIds = new Set(
      selectCapabilityRecipients(
        rows.map((p): RecipientMember => ({ user_id: p.user_id, account_role: p.account_role })),
        overrideRows as RoleOverrideRow[] | null,
        CAPABILITY,
        candidates,
      ),
    )

    const members: SembangDirectoryMember[] = rows
      .filter((p) => recipientIds.has(p.user_id))
      .map((p) => ({
        userId: p.user_id,
        fullName: p.full_name ?? '',
        avatarUrl: p.avatar_url,
        accountRole: p.account_role,
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName))

    return NextResponse.json({ members })
  } catch (err) {
    return toErrorResponse(err)
  }
}
