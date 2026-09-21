import { readFileSync } from "node:fs"
import { join } from "node:path"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

// Render smoke tests for the AI parts of the automation builder in English and
// Korean with the REAL catalogues (next-intl errors are thrown, so a missing key
// or argument fails here instead of showing a raw key path): the AI step
// editors, the Ask AI fields, Create ticket, the Test panel and its result, the
// collapsed step summaries, the run-log rows and the quick-start templates.

const state = vi.hoisted(() => ({ caps: new Set<string>(["automations.manage", "ai.use"]) }))

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
  // Only ever called while rendering (effects do not run in a server render).
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub })
  return { createClient: () => stub }
})

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  usePathname: () => "/",
}))

import {
  AiExtractEditor,
  AiFlowProvider,
  AiReplyEditor,
  AiStatusContext,
  AiStatusProvider,
  AiSummarizeEditor,
  AiTranslateEditor,
  AskAiFields,
  CreateTicketEditor,
  TestResult,
  TestStepPanel,
  type AiEditorSlots,
  type FlowStep,
} from "./ai-steps"
import { AutomationBuilder, type BuilderInitial } from "./automation-builder"
import { StepRow } from "./log-step-row"
import { AUTOMATION_TEMPLATES } from "@/lib/automations/templates"
import type { TestStepResponse } from "@/lib/automations/ai/dry-run"

const load = (locale: string) => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"))

function render(locale: string, node: React.ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={load(locale)}
      timeZone="UTC"
      now={new Date("2026-09-20T12:00:00Z")}
      onError={(e: Error) => {
        throw e
      }}
    >
      {node}
    </NextIntlClientProvider>,
  )
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;")

const Dummy = () => <select data-testid="picker" />
const slots = (t: AiEditorSlots["tBuilder"]): AiEditorSlots => ({ TeamSelect: Dummy, AgentSelect: Dummy, customFields: [], tBuilder: t })

// The editors need the builder's `t` for the shared pickers; a tiny stand-in is enough here.
const tBuilder = ((k: string) => k) as unknown as AiEditorSlots["tBuilder"]

function flow(steps: FlowStep[], node: React.ReactNode) {
  return (
    <AiStatusProvider>
      <AiFlowProvider value={{ steps, triggerType: "new_message_received" }}>{node}</AiFlowProvider>
    </AiStatusProvider>
  )
}

const step = (cid: string, step_type: string, step_config: Record<string, unknown>): FlowStep => ({ cid, step_type, step_config })

describe.each(["en", "ko"])("AI step editors render with %s messages", (locale) => {
  const m = () => load(locale).Automations.builder.ai

  it("AI reply: mode, instructions, language, the assigned-agent option, On failure and the branches hint", () => {
    const s = step("r", "ai_reply", { mode: "send", language: "match", on_failure: "fallback", fallback_text: "Soon." })
    const html = render(locale, flow([s], <AiReplyEditor cid="r" config={s.step_config} set={() => {}} slots={slots(tBuilder)} />))
    expect(html).toContain(esc(m().reply.modeSend))
    expect(html).toContain(esc(m().reply.modeDraft))
    expect(html).toContain(esc(m().reply.evenIfAssigned))
    expect(html).toContain(esc(m().onFailure.label))
    expect(html).toContain(esc(m().onFailure.fallbackText))
    expect(html).toContain(esc(m().reply.branchesHint))
    // The variable picker and the "uses AI tokens" hint are on every AI step.
    expect(html).toContain(esc(m().insertVariable))
    expect(html).toContain(esc(m().tokensHint))
  })

  it("shows the privacy notice on the first AI step only, with a full callout", () => {
    const first = step("a", "ai_summarize", {})
    const second = step("b", "ai_reply", {})
    const html1 = render(locale, flow([first, second], <AiSummarizeEditor cid="a" config={first.step_config} set={() => {}} slots={slots(tBuilder)} />))
    const html2 = render(locale, flow([first, second], <AiReplyEditor cid="b" config={second.step_config} set={() => {}} slots={slots(tBuilder)} />))
    expect(html1).toContain(esc(m().privacyTitle))
    expect(html1).toContain(esc(m().privacyText))
    expect(html2).not.toContain(esc(m().privacyTitle))
  })

  it("Ask AI: the question, messages to read, the unsure-goes-to-No hint and the failure choice", () => {
    const s = step("q", "condition", { subject: "ai_question", operand: "Is the customer angry?", ai_messages: 12 })
    const html = render(locale, flow([s], <AskAiFields cid="q" config={s.step_config} set={() => {}} slots={slots(tBuilder)} />))
    expect(html).toContain(esc(m().ask.question))
    expect(html).toContain(esc(m().ask.unsureHint))
    expect(html).toContain(esc(m().messagesCount))
    expect(html).toContain("Is the customer angry?")
    expect(html).toContain('value="12"')
    expect(html).toContain(esc(m().onFailure.no))
  })

  it("AI extract: presets, a choice field with its target, overwrite and the limit note", () => {
    const s = step("x", "ai_extract", {
      fields: [
        { key: "sentiment", description: "Mood", type: "choice", choices: ["positive", "neutral", "negative"], target: { kind: "label" } },
        { key: "email", description: "Email", type: "text", target: { kind: "contact_field", field: "email" } },
      ],
    })
    const html = render(locale, flow([s], <AiExtractEditor cid="x" config={s.step_config} set={() => {}} slots={slots(tBuilder)} />))
    expect(html).toContain(esc(m().extract.presetSentiment))
    expect(html).toContain(esc(m().extract.presetTopic))
    expect(html).toContain(esc(m().extract.targets.label))
    expect(html).toContain(esc(m().extract.existingOnly))
    expect(html).toContain(esc(m().extract.overwrite))
    expect(html).toContain("positive, neutral, negative")
    expect(html).toContain("vars.sentiment")
  })

  it("AI summarise and AI translate", () => {
    const sum = step("s", "ai_summarize", { save_to: "summary", post_note: true })
    const tr = step("t", "ai_translate", { target_language: "ko", save_to: "translation" })
    const h1 = render(locale, flow([sum], <AiSummarizeEditor cid="s" config={sum.step_config} set={() => {}} slots={slots(tBuilder)} />))
    const h2 = render(locale, flow([tr], <AiTranslateEditor cid="t" config={tr.step_config} set={() => {}} slots={slots(tBuilder)} />))
    expect(h1).toContain(esc(m().summarize.postNote))
    expect(h1).toContain(esc(m().saveTo))
    expect(h2).toContain(esc(m().translate.source))
    expect(h2).toContain(esc(m().translate.target))
  })

  it("Create ticket: type, priority, team, assignee, AI text and skip-if-open", () => {
    const s = step("k", "create_ticket", { subject: "Follow-up", ai_write: true, skip_if_open: true })
    const html = render(locale, flow([s], <CreateTicketEditor cid="k" config={s.step_config} set={() => {}} slots={slots(tBuilder)} />))
    expect(html).toContain(esc(m().ticket.aiWrite))
    expect(html).toContain(esc(m().ticket.skipIfOpen))
    expect(html).toContain(esc(m().ticket.subjectFallbackHint))
    expect(html).toContain(esc(m().ticket.team))
  })

  it("shows the not-set-up warning with a link to AI Agents > Setup, and the notice variant", () => {
    const s = step("r", "ai_reply", {})
    const withStatus = (status: { available: boolean | null; code?: string }) =>
      render(
        locale,
        <AiStatusContext.Provider value={status}>
          <AiFlowProvider value={{ steps: [s], triggerType: "new_message_received" }}>
            <AiReplyEditor cid="r" config={s.step_config} set={() => {}} slots={slots(tBuilder)} />
          </AiFlowProvider>
        </AiStatusContext.Provider>,
      )
    const notSetUp = withStatus({ available: false, code: "ai_not_configured" })
    expect(notSetUp).toContain(esc(m().notConfigured))
    expect(notSetUp).toContain('href="/agents?tab=setup"')
    expect(notSetUp).toContain(esc(m().setupLink))
    expect(withStatus({ available: false, code: "notice_required" })).toContain(esc(m().noticeRequired))
    // Set up (or not known yet): no warning.
    expect(withStatus({ available: true })).not.toContain(esc(m().notConfigured))
    expect(withStatus({ available: null })).not.toContain(esc(m().notConfigured))
  })

  it("warns when there are more than 5 AI steps", () => {
    const steps = Array.from({ length: 6 }, (_, i) => step(`s${i}`, "ai_summarize", {}))
    const html = render(locale, flow(steps, <AiSummarizeEditor cid="s0" config={{}} set={() => {}} slots={slots(tBuilder)} />))
    expect(html).toContain(esc(m().tooMany.replace("{count}", "6").replace("{max}", "5")))
  })
})

describe.each(["en", "ko"])("the Test panel renders with %s messages", (locale) => {
  const t = () => load(locale).Automations.builder.ai.test

  it("collapsed: the Test this step button", () => {
    const html = render(locale, flow([], <TestStepPanel stepType="ai_reply" config={{}} />))
    expect(html).toContain(esc(t().button))
    // The attribute, not the `disabled:` utility classes every button carries.
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/)
  })

  it("is disabled, with the reason, for someone without ai.use", () => {
    state.caps = new Set(["automations.manage"])
    try {
      const html = render(locale, flow([], <TestStepPanel stepType="ai_reply" config={{}} />))
      expect(html).toMatch(/\sdisabled(=|\s|>)/)
      expect(html).toContain(esc(t().needsAiUse))
    } finally {
      state.caps = new Set(["automations.manage", "ai.use"])
    }
  })

  const base: TestStepResponse = { outcome: "answered", branch: "yes", text: "We can refund you.", tokens: 1, notes: [], wouldDo: [], summary: "" }

  it("an AI reply: the outcome, the branch it continues down, the reply and what it would do", () => {
    const html = render(
      locale,
      <TestResult stepType="ai_reply" result={{ ...base, tokens: 421, wouldDo: [{ kind: "send_reply", text: "We can refund you." }] }} />,
    )
    expect(html).toContain(esc(t().outcomes.answered))
    expect(html).toContain(esc(t().goesTo.replace("{branch}", t().branchAnswered)))
    expect(html).toContain("We can refund you.")
    expect(html).toContain(esc(t().wouldDo))
    expect(html).toContain(esc(t().would.send_reply))
    expect(html).toContain(esc(t().nothingChanged))
    expect(html).toContain(locale === "en" ? "421 tokens" : "토큰 421개")
  })

  it("couldn't answer, with why", () => {
    const html = render(locale, <TestResult stepType="ai_reply" result={{ ...base, outcome: "couldnt_answer", branch: "no", text: "", reason: "agent_assigned" }} />)
    expect(html).toContain(esc(t().outcomes.couldnt_answer))
    expect(html).toContain(esc(t().reasons.agent_assigned))
    expect(html).toContain(esc(t().goesTo.replace("{branch}", t().branchCouldnt)))
  })

  it("Ask AI: yes / no / unsure with the model's short reason", () => {
    const html = render(locale, <TestResult stepType="condition" result={{ ...base, outcome: "unsure", branch: "no", text: "unsure", reason: "too little to tell" }} />)
    expect(html).toContain(esc(t().outcomes.unsure))
    expect(html).toContain(esc(t().reason))
    expect(html).toContain("too little to tell")
    expect(html).toContain(esc(t().goesTo.replace("{branch}", t().branchNo)))
  })

  it("extract: the JSON and the notes", () => {
    const html = render(
      locale,
      <TestResult
        stepType="ai_extract"
        result={{ ...base, outcome: "extracted", branch: null, json: { sentiment: "negative" }, notes: ["email: not a valid email (not saved)"], wouldDo: [{ kind: "label", name: "Negative" }] }}
      />,
    )
    expect(html).toContain(esc(JSON.stringify({ sentiment: "negative" }, null, 2)))
    expect(html).toContain("email: not a valid email (not saved)")
    expect(html).toContain(esc(t().would.label.replace("{name}", "Negative")))
  })

  it("a failure shows a plain reason, not a raw code", () => {
    const html = render(locale, <TestResult stepType="ai_summarize" result={{ ...base, outcome: "failed", branch: null, text: "", failure: { code: "budget_exceeded", message: "AI budget used up" } }} />)
    expect(html).toContain(esc(t().errors.budget_exceeded))
    expect(html).toContain(esc(t().outcomes.failed))
  })

  it("Create ticket: the subject, description and a skipped note", () => {
    const html = render(
      locale,
      <TestResult
        stepType="create_ticket"
        result={{ ...base, outcome: "skipped", branch: null, text: "Refund request", ticket: { subject: "Refund request", description: "Wants a refund.", skip: "open_ticket_exists", usedAi: true } }}
      />,
    )
    expect(html).toContain("Refund request")
    expect(html).toContain(esc(t().ticketSkipped))
  })
})

describe.each(["en", "ko"])("the builder and logs render AI steps with %s messages", (locale) => {
  const b = () => load(locale).Automations.builder

  const initial: BuilderInitial = {
    name: "AI flow",
    description: "",
    trigger_type: "conversation_closed",
    trigger_config: {},
    is_active: false,
    steps: [
      { cid: "1", step_type: "ai_reply", step_config: { mode: "send" }, branches: { yes: [], no: [] } },
      { cid: "2", step_type: "condition", step_config: { subject: "ai_question", operand: "Is the customer asking for a refund?" }, branches: { yes: [], no: [] } },
      { cid: "3", step_type: "ai_extract", step_config: { fields: [{ key: "sentiment", type: "text", description: "d" }] } },
      { cid: "4", step_type: "ai_summarize", step_config: { post_note: true } },
      { cid: "5", step_type: "ai_translate", step_config: { target_language: "ko" } },
      { cid: "6", step_type: "create_ticket", step_config: { subject: "Follow-up" } },
    ],
  }

  it("shows the Conversation closed trigger, the AI step names and their one-line summaries", () => {
    const html = render(locale, <AutomationBuilder initial={initial} />)
    expect(html).toContain(esc(b().triggers.conversation_closed.label))
    for (const k of ["ai_reply", "ai_extract", "ai_summarize", "ai_translate", "create_ticket", "ai_question"]) {
      expect(html).toContain(esc(b().steps[k]))
    }
    expect(html).toContain(esc(b().ai.summary.replySend))
    expect(html).toContain(esc(b().ai.summary.ask.replace("{question}", "Is the customer asking for a refund?")))
    expect(html).toContain(esc(b().ai.summary.extract.replace("{keys}", "sentiment")))
    expect(html).toContain(esc(b().ai.summary.summarizeNote))
    expect(html).toContain(esc(b().ai.summary.translate.replace("{language}", "ko")))
    expect(html).toContain(esc(b().ai.summary.ticket.replace("{subject}", "Follow-up")))
    // AI reply renders Answered / Couldn't answer columns; Ask AI keeps Yes / No.
    expect(html).toContain(esc(b().branches.answered))
    expect(html).toContain(esc(b().branches.couldnt))
    expect(html).toContain(esc(b().branches.yes))
    // The AI badge on the cards.
    expect(html).toContain(esc(b().kindAi))
  })

  it("run-log rows: step name, outcome, tokens and the truncated output", () => {
    const logs = load(locale).Automations.logs
    const html = render(
      locale,
      <ul>
        <StepRow
          result={{ step_id: "s1", step_type: "ai_reply", status: "success", detail: "answered (sent)", outcome: "answered", tokens: 88, output: "We can refund you within 5 days." }}
        />
        <StepRow result={{ step_id: "s2", step_type: "ai_extract", status: "skipped", detail: "failed: The AI provider took too long to respond.", outcome: "failed", tokens: 0 }} />
        <StepRow result={{ step_id: "s3", step_type: "send_message", status: "success", detail: "sent" }} />
      </ul>,
    )
    expect(html).toContain(esc(b().steps.ai_reply))
    expect(html).toContain(esc(logs.outcomes.answered))
    expect(html).toContain(esc(locale === "en" ? "88 tokens" : "토큰 88개"))
    expect(html).toContain("We can refund you within 5 days.")
    expect(html).toContain(esc(logs.outcomes.failed))
    // A plain step keeps its raw type name, as before.
    expect(html).toContain("send_message")
  })
})

describe.each(["en", "ko"])("quick-start templates in %s", (locale) => {
  const tpl = () => load(locale).Automations.templates

  it("every template has a localised name and description", () => {
    for (const slug of Object.keys(AUTOMATION_TEMPLATES)) {
      expect(tpl()[slug]?.name, `${slug} name`).toBeTruthy()
      expect(tpl()[slug]?.description, `${slug} description`).toBeTruthy()
    }
  })

  it("every seed key a template names exists in the catalogue", () => {
    for (const def of Object.values(AUTOMATION_TEMPLATES)) {
      for (const seed of def.steps) {
        for (const key of Object.values(seed.i18n ?? {})) {
          expect(tpl()[def.slug].seed?.[key], `${def.slug}.seed.${key}`).toBeTruthy()
        }
      }
    }
  })

  it("the trigger and the step names a template uses have labels", () => {
    const builder = load(locale).Automations.builder
    for (const def of Object.values(AUTOMATION_TEMPLATES)) {
      expect(builder.triggers[def.trigger_type]?.label, def.trigger_type).toBeTruthy()
      for (const seed of def.steps) expect(builder.steps[seed.step_type], seed.step_type).toBeTruthy()
    }
  })
})
