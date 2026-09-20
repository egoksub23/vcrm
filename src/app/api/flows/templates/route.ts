import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { listFlowTemplates } from '@/lib/flows/templates'

/**
 * GET /api/flows/templates
 *
 * Returns the static template gallery (slug + name + description +
 * icon hint + node_count) so the New-flow dialog can render cards
 * without bundling the full template payloads client-side. Bodies
 * are fetched only on actual clone via POST /api/flows.
 *
 * Needs `menu.flows` (every role by default). Flows is in soft-GA.
 */
export async function GET() {
  // The gallery belongs to the Flows menu: `menu.flows` (every role by
  // default).
  try {
    await requireCapability('menu.flows')
  } catch (err) {
    return toErrorResponse(err)
  }
  // Shallow shape so the client gallery doesn't have to know about
  // the full node tree.
  const templates = listFlowTemplates().map((t) => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    icon: t.icon,
    trigger_type: t.trigger_type,
    node_count: t.nodes.length,
  }))
  return NextResponse.json({ templates })
}
