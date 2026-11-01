import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

interface PublicFormItem {
  typeKey: string
  slug: string
  label: string
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    // Only return forms when the compliance feature is enabled for this workspace.
    const { data: platform } = await ctx.supabase
      .from('account_platform')
      .select('features')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    const features = (platform?.features ?? {}) as Record<string, boolean>
    if (!features.compliance) {
      return NextResponse.json({ forms: [] })
    }

    const { data: rows } = await ctx.supabase
      .from('compliance_public_forms')
      .select('type_key, slug')
      .eq('account_id', ctx.accountId)
      .eq('enabled', true)

    if (!rows?.length) return NextResponse.json({ forms: [] })

    const typeKeys = rows .map((r: any) => r.type_key as string)
    const { data: types } = await ctx.supabase
      .from('compliance_request_types')
      .select('key, label')
      .eq('account_id', ctx.accountId)
      .in('key', typeKeys)
      .eq('active', true)

    const labelMap = new Map((types ?? []) .map((t: any) => [t.key as string, t.label as string]))

    const forms: PublicFormItem[] = rows
       .filter((r: any) => r.slug && labelMap.has(r.type_key as string))
       .map((r: any) => ({
        typeKey: r.type_key as string,
        slug: r.slug as string,
        label: labelMap.get(r.type_key as string) ?? (r.type_key as string),
      }))

    return NextResponse.json({ forms })
  } catch (err) {
    return toErrorResponse(err)
  }
}
