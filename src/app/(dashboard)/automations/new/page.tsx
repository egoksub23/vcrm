"use client"

import { Suspense, useMemo } from "react"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"

import {
  AutomationBuilder,
  type BuilderInitial,
  type BuilderStep,
} from "@/components/automations/automation-builder"
import { AUTOMATION_TEMPLATES, type TemplateSlug } from "@/lib/automations/templates"
import { hasBranches } from "@/lib/automations/step-kinds"
import type { AutomationStepType, AutomationTriggerType } from "@/types"

// `useSearchParams` requires a Suspense boundary or the production build
// bails to CSR and errors out. Thin wrapper supplies it; the inner
// component reads the `?template=` query string.
export default function NewAutomationPage() {
  return (
    <Suspense fallback={null}>
      <NewAutomationPageInner />
    </Suspense>
  )
}

function NewAutomationPageInner() {
  const params = useSearchParams()
  const template = params.get("template") as TemplateSlug | null
  const tTemplates = useTranslations("Automations.templates")

  const initial: BuilderInitial = useMemo(() => {
    if (template && AUTOMATION_TEMPLATES[template]) {
      const t = AUTOMATION_TEMPLATES[template]
      const steps = expandFromSeeds(
        t.steps.map((seed, idx) => ({
          index: idx,
          step_type: seed.step_type,
          // Seeds keep an English default; the catalogue's text replaces it in the
          // user's language where the template names one (seed.i18n).
          step_config: {
            ...(seed.step_config as Record<string, unknown>),
            ...Object.fromEntries(
              Object.entries(seed.i18n ?? {})
                .filter(([, key]) => tTemplates.has(`${template}.seed.${key}`))
                // raw(): a seed may hold {{ vars.x }} placeholders, which are not ICU.
                .map(([field, key]) => [field, String(tTemplates.raw(`${template}.seed.${key}`))]),
            ),
          },
          branch: seed.branch ?? null,
          parent_index: seed.parent_index ?? null,
        })),
      )
      return {
        name: tTemplates.has(`${template}.name`) ? tTemplates(`${template}.name`) : t.name,
        description: tTemplates.has(`${template}.description`)
          ? tTemplates(`${template}.description`)
          : t.description,
        trigger_type: t.trigger_type,
        trigger_config: t.trigger_config as Record<string, unknown>,
        is_active: false,
        steps,
      }
    }
    return {
      name: "",
      description: "",
      trigger_type: "new_message_received" as AutomationTriggerType,
      trigger_config: {},
      is_active: false,
      steps: [],
    }
  }, [template, tTemplates])

  return <AutomationBuilder initial={initial} />
}

interface SeedRow {
  index: number
  step_type: AutomationStepType
  step_config: Record<string, unknown>
  branch: "yes" | "no" | null
  parent_index: number | null
}

function uid(): string {
  return (
    "c_" +
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  )
}

/** Template seeds are flat with parent_index references. Expand into the
 *  builder's nested tree, preserving order within each scope. */
function expandFromSeeds(rows: SeedRow[]): BuilderStep[] {
  const nodes: BuilderStep[] = rows.map((r) => ({
    cid: uid(),
    step_type: r.step_type,
    step_config: r.step_config,
    branches: hasBranches(r.step_type) ? { yes: [], no: [] } : undefined,
  }))
  const roots: BuilderStep[] = []
  rows.forEach((r, i) => {
    if (r.parent_index == null) {
      roots.push(nodes[i])
      return
    }
    const parent = nodes[r.parent_index]
    if (!parent.branches) parent.branches = { yes: [], no: [] }
    parent.branches[r.branch ?? "yes"].push(nodes[i])
  })
  return roots
}
