import { readFileSync } from "node:fs"
import { join } from "node:path"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

// Render smoke tests for the Doc Sign parts of the automation builder, in all four languages with the REAL
// catalogues (next-intl errors are thrown, so a missing key or argument fails here instead of showing a raw key
// path): the trigger panel, the Send document for signing editor, the collapsed step summary, the log rows and
// the two recipes.

const state = vi.hoisted(() => ({ caps: new Set<string>(["automations.manage", "menu.sign"]) }))

vi.mock("@/hooks/use-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-auth")>()
  return {
    ...actual,
    useAuth: () => ({
      accountId: "acc-1",
      user: { id: "u-me" },
      accountRole: "admin",
      defaultCurrency: "USD",
      currencies: [],
      capabilities: state.caps,
      capabilitiesLoading: false,
      profileLoading: false,
      loading: false,
    }),
    useCapability: (cap: string) => state.caps.has(cap),
  }
})

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub })
  return { createClient: () => stub }
})

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  usePathname: () => "/",
}))

import { AiFlowProvider } from "./ai-steps"
import { AutomationBuilder, type BuilderInitial } from "./automation-builder"
import { StepRow } from "./log-step-row"
import { SendSignDocumentEditor, SignResourcesContext, SignTriggerConfig } from "./sign-steps"
import { AUTOMATION_TEMPLATES } from "@/lib/automations/templates"

const load = (locale: string) => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"))

function render(locale: string, node: React.ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={load(locale)}
      timeZone="UTC"
      now={new Date("2026-10-07T12:00:00Z")}
      onError={(e: Error) => {
        throw e
      }}
    >
      {node}
    </NextIntlClientProvider>,
  )
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;")

const withTemplates = (node: React.ReactNode) => (
  <SignResourcesContext.Provider
    value={{
      loaded: true,
      templates: [{ id: "tpl-1", name: "Merchant Application", status: "active", category_id: "cat-1", current_version_id: "ver-1" }],
      categories: [{ id: "cat-1", name: "Merchant agreements" }],
    }}
  >
    {node}
  </SignResourcesContext.Provider>
)

const flow = (node: React.ReactNode) => (
  <AiFlowProvider value={{ steps: [{ cid: "s", step_type: "send_sign_document", step_config: {} }], triggerType: "sign_document_event" }}>{node}</AiFlowProvider>
)

describe.each(["en", "ms", "zh", "ko"])("the Doc Sign trigger and step render with %s messages", (locale) => {
  const b = () => load(locale).Automations.builder
  const s = () => b().sign

  it("the trigger panel lists the six events with completed ticked when nothing is chosen, and the filters", () => {
    const html = render(locale, withTemplates(<SignTriggerConfig config={{}} onChange={() => {}} />))
    for (const e of ["sent", "viewed", "completed", "declined", "expired", "voided"]) expect(html).toContain(esc(s().trigger.event[e]))
    expect(html).toContain(esc(s().trigger.eventsHint))
    expect(html).toContain(esc(s().trigger.anyTemplate))
    expect(html).toContain(esc(s().trigger.anyCategory))
    expect(html).toContain("Merchant Application")
    // exactly one box is ticked: completed
    expect((html.match(/checked=""/g) ?? []).length).toBe(1)
  })

  it("the trigger panel with chosen events ticks those", () => {
    const html = render(locale, withTemplates(<SignTriggerConfig config={{ events: ["sent", "declined"], template_id: "tpl-1" }} onChange={() => {}} />))
    expect((html.match(/checked=""/g) ?? []).length).toBe(2)
  })

  it("without templates the filter falls back to an id box", () => {
    const html = render(locale, <SignTriggerConfig config={{}} onChange={() => {}} />)
    expect(html).toContain(esc(s().trigger.templateId))
  })

  it("the step editor: template, title, recipients, merge values, message, language, send", () => {
    const cfg = {
      template_id: "tpl-1",
      title: "Application",
      recipients: [
        { role_key: "merchant", source: "contact", channel: "email" },
        { role_key: "director", source: "fixed", channel: "whatsapp", full_name: "Dato Aziz", email: "d@x.my", phone: "0123456789" },
      ],
      merge_values: { company: "{{ contact.company }}" },
      send: true,
    }
    const html = render(locale, flow(withTemplates(<SendSignDocumentEditor cid="s" config={cfg} set={() => {}} />)))
    for (const k of ["template", "title", "recipients", "role", "source", "channel", "contactNote", "fullName", "email", "phone", "addRecipient", "merge", "mergeKey", "mergeValue", "addMerge", "message", "language", "languageDefault", "send", "sendHint"]) {
      expect(html, k).toContain(esc(s().step[k]))
    }
    expect(html).toContain(esc(s().step.selectTemplate))
    expect(html).toContain("Merchant Application")
    // the insert-variable button of the AI editors is reused
    expect(html).toContain(esc(b().ai.insertVariable))
    for (const l of ["en", "ms", "zh", "ko"]) expect(html).toContain(esc(s().step.languages[l]))
  })

  it("a recipe's template hint is shown while no template is chosen, and a missing-templates note when none are readable", () => {
    const empty = render(locale, flow(<SendSignDocumentEditor cid="s" config={{ template_id: "", template_hint: "Merchant Application", recipients: [], merge_values: {} }} set={() => {}} />))
    expect(empty).toContain(esc(s().step.templateHint.replace("{name}", "Merchant Application")))
  })

  it("the collapsed step shows its name and a one-line summary", () => {
    const initial: BuilderInitial = {
      name: "Merchant onboarding",
      description: "",
      trigger_type: "sign_document_event",
      trigger_config: { events: ["completed"] },
      is_active: false,
      steps: [
        { cid: "1", step_type: "send_sign_document", step_config: { template_id: "tpl-1", recipients: [{ role_key: "merchant", source: "contact", channel: "email" }, { role_key: "director", source: "contact", channel: "email" }], merge_values: {} } },
        { cid: "2", step_type: "send_sign_document", step_config: { template_id: "", recipients: [], merge_values: {} } },
      ],
    }
    const html = render(locale, <AutomationBuilder initial={initial} />)
    expect(html).toContain(esc(b().triggers.sign_document_event.label))
    expect(html).toContain(esc(b().steps.send_sign_document))
    expect(html).toContain(esc(s().step.summaryEmpty))
    // two recipients: the count goes through the plural (English) or the plain form
    expect(html).toMatch(locale === "en" ? /2 people sign/ : /2/)
  })

  it("log rows name the step and word the outcomes", () => {
    const logs = load(locale).Automations.logs
    const html = render(
      locale,
      <ul>
        <StepRow result={{ step_id: "a", step_type: "send_sign_document", status: "success", detail: "document SIGN-1 sent to 1 person", outcome: "sent" }} />
        <StepRow result={{ step_id: "b", step_type: "send_sign_document", status: "skipped", detail: "skipped: limit", outcome: "sign_limit_reached" }} />
        <StepRow result={{ step_id: "c", step_type: "send_sign_document", status: "skipped", detail: "skipped: no email", outcome: "recipient_email_missing" }} />
      </ul>,
    )
    expect(html).toContain(esc(b().steps.send_sign_document))
    expect(html).toContain(esc(logs.outcomes.sent))
    expect(html).toContain(esc(logs.outcomes.sign_limit_reached))
    expect(html).toContain(esc(logs.outcomes.recipient_email_missing))
  })

  it("the recipes have names, descriptions, labels for their trigger and steps, and every seed they name", () => {
    const tpl = load(locale).Automations.templates
    for (const slug of ["merchant_onboarding", "merchant_signed_followup"] as const) {
      const def = AUTOMATION_TEMPLATES[slug]
      expect(tpl[slug].name, `${slug} name`).toBeTruthy()
      expect(tpl[slug].description, `${slug} description`).toBeTruthy()
      expect(b().triggers[def.trigger_type]?.label, def.trigger_type).toBeTruthy()
      expect(b().triggers[def.trigger_type]?.hint, def.trigger_type).toBeTruthy()
      for (const seed of def.steps) {
        expect(b().steps[seed.step_type], seed.step_type).toBeTruthy()
        for (const key of Object.values(seed.i18n ?? {})) expect(tpl[slug].seed?.[key], `${slug}.seed.${key}`).toBeTruthy()
      }
    }
  })

  it("a tag the recipe suggests is named while none is picked", () => {
    const initial: BuilderInitial = {
      name: "Merchant onboarding",
      description: "",
      trigger_type: "tag_added",
      trigger_config: { tag_id: "", tag_hint: "Merchant applicant" },
      is_active: false,
      steps: [],
    }
    // the trigger card is collapsed until clicked, so the hint is checked on the message itself
    expect(() => render(locale, <AutomationBuilder initial={initial} />)).not.toThrow()
    expect(b().tags.hint).toContain("{name}")
  })
})
