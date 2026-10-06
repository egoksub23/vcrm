import type { SupabaseClient } from '@supabase/supabase-js'

import { signEnabled } from '@/lib/sign/feature'
import type { SignRole } from '@/lib/sign/types'
import type { PlacedField } from '@/lib/sign/pdf/types'
import type { FormDefinition } from '@/lib/sign/forms/types'
import { requiredRoleKeys, type SignSetup } from './sign-step'

interface StepNode {
  step_type: string
  step_config?: Record<string, unknown>
  branches?: { yes?: StepNode[]; no?: StepNode[] }
}

/** The template ids the Send document for signing steps of a step tree name. */
export function signTemplateIdsOf(steps: StepNode[] | undefined): string[] {
  const out = new Set<string>()
  const walk = (list: StepNode[] | undefined) => {
    for (const s of list ?? []) {
      if (s.step_type === 'send_sign_document') {
        const id = s.step_config?.template_id
        if (typeof id === 'string' && id.trim()) out.add(id.trim())
      }
      walk(s.branches?.yes)
      walk(s.branches?.no)
    }
  }
  walk(steps)
  return [...out]
}

export function stepsUseSign(steps: StepNode[] | undefined): boolean {
  const walk = (list: StepNode[] | undefined): boolean =>
    (list ?? []).some((s) => s.step_type === 'send_sign_document' || walk(s.branches?.yes) || walk(s.branches?.no))
  return walk(steps)
}

/**
 * The Doc Sign part of the activation check, for the create and update routes (the shape of
 * `aiSetupForActivation`). Looks at the workspace only when the automation uses Doc Sign (a Send document for
 * signing step, or the Doc Sign trigger); returns undefined otherwise, so an automation without it never
 * touches Doc Sign tables.
 */
export async function signSetupForActivation(
  db: SupabaseClient,
  accountId: string,
  steps: StepNode[] | undefined,
  triggerType?: string,
): Promise<SignSetup | undefined> {
  const usesStep = stepsUseSign(steps)
  if (!usesStep && triggerType !== 'sign_document_event') return undefined
  const enabled = await signEnabled(db, accountId)
  const setup: SignSetup = { enabled, templates: {} }
  if (!enabled) return setup

  for (const id of signTemplateIdsOf(steps)) {
    const t = await db
      .from('sign_templates')
      .select('id, status, current_version_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    const row = t.data as { id: string; status: string; current_version_id: string | null } | null
    if (!row) {
      setup.templates[id] = { found: false, active: false, roles: [], requiredRoles: [] }
      continue
    }
    let roles: SignRole[] = []
    let required: string[] = []
    if (row.current_version_id) {
      const v = await db
        .from('sign_template_versions')
        .select('roles, fields, form')
        .eq('id', row.current_version_id)
        .eq('account_id', accountId)
        .maybeSingle()
      const ver = v.data as { roles: SignRole[]; fields: PlacedField[]; form: FormDefinition | null } | null
      if (ver) {
        roles = ver.roles ?? []
        required = requiredRoleKeys({ roles, fields: ver.fields ?? [], form: ver.form })
      }
    }
    setup.templates[id] = {
      found: true,
      // a template with no saved version cannot make a document, whatever its status says
      active: row.status === 'active' && !!row.current_version_id,
      roles: roles.map((r) => ({ key: r.key, kind: r.kind, label: r.label })),
      requiredRoles: required,
    }
  }
  return setup
}
