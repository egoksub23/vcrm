"use client"

import Link from 'next/link'
import { UserPlus, Briefcase, Radio, Zap } from 'lucide-react'
import type { ComponentType } from 'react'

import { useTranslations } from 'next-intl'
import { useAuth } from '@/hooks/use-auth'
import { filterByCapability } from '@/lib/auth/page-access'

// Quick-action shortcuts. Each navigates to the page that owns the
// relevant "create" flow. We deliberately don't try to auto-open any
// modal on the target page — that'd require touching those pages,
// which is out of scope here.
interface Action {
  labelKey: string
  href: string
  icon: ComponentType<{ className?: string }>
  tint: string
  /** Menu capability of the page the shortcut opens. */
  capability: string
}

const ACTIONS: Action[] = [
  { labelKey: 'newContact', href: '/contacts', icon: UserPlus, tint: 'text-primary', capability: 'menu.contacts' },
  { labelKey: 'newDeal', href: '/pipelines', icon: Briefcase, tint: 'text-blue-400', capability: 'menu.pipelines' },
  { labelKey: 'newBroadcast', href: '/broadcasts/new', icon: Radio, tint: 'text-amber-400', capability: 'menu.broadcasts' },
  { labelKey: 'newAutomation', href: '/automations/new', icon: Zap, tint: 'text-primary', capability: 'menu.automations' },
]

export function QuickActions() {
  const t = useTranslations('Dashboard.quickActions')
  const { capabilities } = useAuth()
  // Hide shortcuts to pages the person has no menu for.
  const visible = filterByCapability(ACTIONS, (cap) => capabilities.has(cap))

  if (visible.length === 0) return null

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {visible.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.href}
            href={a.href}
            className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-border hover:bg-muted/60"
          >
            <div className={`flex h-9 w-9 items-center justify-center rounded-lg bg-muted ${a.tint}`}>
              <Icon className="h-4 w-4" />
            </div>
            <span className="text-sm font-medium text-foreground">{t(a.labelKey as string)}</span>
          </Link>
        )
      })}
    </div>
  )
}
