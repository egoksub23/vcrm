"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react"
import Link from "next/link"
import { useLocale, useTranslations } from "next-intl"
import {
  AlertTriangle,
  Loader2,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  Variable,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useCapability } from "@/hooks/use-can"
import { cn } from "@/lib/utils"
import { languageOptions } from "@/lib/contacts/locale-options"
import { variablesFor } from "@/lib/automations/ai/vars"
import { countAiSteps, flattenSteps, usesAi } from "@/lib/automations/step-kinds"
import {
  AI_EXTRACT_MAX_CHOICES,
  AI_EXTRACT_MAX_FIELDS,
  AI_MESSAGES_DEFAULT,
  AI_MESSAGES_MAX,
  AI_MESSAGES_MIN,
} from "@/lib/automations/ai/types"
import { MAX_AI_STEPS_PER_RUN } from "@/lib/automations/step-kinds"
import type { TestStepResponse } from "@/lib/automations/ai/dry-run"
import type { AiExtractField, AiFieldType, CustomField } from "@/types"

// ------------------------------------------------------------
// The AI parts of the automation builder: the editors for the AI steps and
// Create ticket, the privacy / not-set-up notices, the "Insert variable"
// dropdown and the per-step Test panel. Kept out of automation-builder.tsx so
// that file stays about layout and the step tree.
// ------------------------------------------------------------

/** The step tree, structurally (the builder's BuilderStep satisfies it). */
export interface FlowStep {
  cid: string
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes: FlowStep[]; no: FlowStep[] }
}

interface FlowContextValue {
  steps: FlowStep[]
  triggerType: string
}

const FlowContext = createContext<FlowContextValue>({ steps: [], triggerType: "" })
export const AiFlowProvider = FlowContext.Provider

interface AiStatus {
  /** null while it loads. */
  available: boolean | null
  code?: string
}

/** Exported so tests can render the "not set up" states without a fetch. */
export const AiStatusContext = createContext<AiStatus>({ available: null })

/** Loads whether AI steps can run (set up, on, notice confirmed) once per builder. */
export function AiStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AiStatus>({ available: null })
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/automations/ai-status", { cache: "no-store" })
        if (!res.ok) return
        const json = (await res.json()) as { available?: boolean; code?: string }
        if (!cancelled) setStatus({ available: json.available !== false, code: json.code })
      } catch {
        // Unknown: show no warning rather than a wrong one.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  return <AiStatusContext.Provider value={status}>{children}</AiStatusContext.Provider>
}

/** What the builder hands the editors: shared pickers it already owns. */
export interface AiEditorSlots {
  TeamSelect: ComponentType<{ value: string; onChange: (v: string) => void; t: ReturnType<typeof useTranslations> }>
  AgentSelect: ComponentType<{ value: string; onChange: (v: string) => void; t: ReturnType<typeof useTranslations> }>
  customFields: CustomField[]
  /** `t` for the builder's own namespace (the pickers use its keys). */
  tBuilder: ReturnType<typeof useTranslations>
}

interface EditorProps {
  cid: string
  config: Record<string, unknown>
  set: (patch: Record<string, unknown>) => void
  slots: AiEditorSlots
}

const INPUT = "bg-muted text-foreground"
const SELECT =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Check({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <div className="mb-2 last:mb-0">
      <label className="flex items-start gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5"
        />
        <span>{label}</span>
      </label>
      {hint && <p className="ml-5 mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

// ------------------------------------------------------------
// Notices: not set up, privacy, tokens, too many AI steps
// ------------------------------------------------------------

export function AiNotices({ cid }: { cid: string }) {
  const t = useTranslations("Automations.builder.ai")
  const status = useContext(AiStatusContext)
  const flow = useContext(FlowContext)
  const flat = useMemo(() => flattenSteps(flow.steps), [flow.steps])
  const isFirst = flat.find((s) => usesAi(s))?.cid === cid
  const count = countAiSteps(flow.steps)

  return (
    <div className="mb-3 space-y-2">
      {status.available === false && (
        <div
          role="alert"
          className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <div>
            <p>{status.code === "notice_required" ? t("noticeRequired") : t("notConfigured")}</p>
            <Link href="/agents?tab=setup" className="mt-1 inline-block font-medium underline">
              {t("setupLink")}
            </Link>
          </div>
        </div>
      )}
      {count > MAX_AI_STEPS_PER_RUN && (
        <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {t("tooMany", { count, max: MAX_AI_STEPS_PER_RUN })}
        </div>
      )}
      {isFirst && (
        <div className="flex gap-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          <div>
            <p className="font-medium text-foreground">{t("privacyTitle")}</p>
            <p className="mt-0.5">{t("privacyText")}</p>
          </div>
        </div>
      )}
      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Sparkles className="h-3 w-3" aria-hidden />
        {t("tokensHint")}
      </p>
    </div>
  )
}

// ------------------------------------------------------------
// Insert variable
// ------------------------------------------------------------

function PromptField({
  cid,
  label,
  value,
  onChange,
  placeholder,
  hint,
  rows = 3,
  single = false,
}: {
  cid: string
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
  rows?: number
  single?: boolean
}) {
  const t = useTranslations("Automations.builder.ai")
  const flow = useContext(FlowContext)
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  const options = useMemo(
    () => variablesFor(flow.steps, cid, { triggerType: flow.triggerType }),
    [flow.steps, flow.triggerType, cid],
  )
  const groups = [
    { id: "trigger", items: options.filter((o) => o.group === "trigger") },
    { id: "contact", items: options.filter((o) => o.group === "contact") },
    { id: "step", items: options.filter((o) => o.group === "step") },
  ].filter((g) => g.items.length > 0)

  function insert(token: string) {
    const el = ref.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    const next = value.slice(0, start) + token + value.slice(end)
    onChange(next)
    // Put the cursor after the token once React has rendered the new value.
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      const pos = start + token.length
      el.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="block text-xs font-medium text-muted-foreground">{label}</label>
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
            <Variable className="h-3 w-3" aria-hidden />
            {t("insertVariable")}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-72 min-w-52 overflow-y-auto border-border bg-popover">
            {groups.map((g) => (
              // A Group is required around a Label (base-ui).
              <DropdownMenuGroup key={g.id}>
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t(`variableGroups.${g.id}`)}
                </DropdownMenuLabel>
                {g.items.map((o) => (
                  <DropdownMenuItem key={o.token} onClick={() => insert(o.token)}>
                    <span className="font-mono text-xs">{o.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {single ? (
        <Input
          ref={ref as React.Ref<HTMLInputElement>}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={INPUT}
        />
      ) : (
        <Textarea
          ref={ref as React.Ref<HTMLTextAreaElement>}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          className={cn("min-h-16", INPUT)}
        />
      )}
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

// ------------------------------------------------------------
// On failure
// ------------------------------------------------------------

function OnFailureField({
  value,
  onChange,
  allow,
  fallbackText,
  onFallbackText,
}: {
  value: string
  onChange: (v: string) => void
  allow: ("stop" | "skip" | "fallback" | "no")[]
  fallbackText?: string
  onFallbackText?: (v: string) => void
}) {
  const t = useTranslations("Automations.builder.ai")
  return (
    <>
      <Field label={t("onFailure.label")}>
        <select value={value} onChange={(e) => onChange(e.target.value)} className={SELECT}>
          {allow.map((o) => (
            <option key={o} value={o}>
              {t(`onFailure.${o}`)}
            </option>
          ))}
        </select>
      </Field>
      {value === "fallback" && onFallbackText && (
        <Field label={t("onFailure.fallbackText")} hint={t("onFailure.fallbackHint")}>
          <Textarea
            value={fallbackText ?? ""}
            onChange={(e) => onFallbackText(e.target.value)}
            rows={2}
            placeholder={t("onFailure.fallbackPlaceholder")}
            className={cn("min-h-12", INPUT)}
          />
        </Field>
      )}
    </>
  )
}

function MessagesCountField({ value, onChange }: { value: unknown; onChange: (n: number) => void }) {
  const t = useTranslations("Automations.builder.ai")
  const n = typeof value === "number" ? value : AI_MESSAGES_DEFAULT
  return (
    <Field label={t("messagesCount")} hint={t("messagesCountHint", { min: AI_MESSAGES_MIN, max: AI_MESSAGES_MAX })}>
      <Input
        type="number"
        min={AI_MESSAGES_MIN}
        max={AI_MESSAGES_MAX}
        value={n}
        onChange={(e) =>
          onChange(Math.min(AI_MESSAGES_MAX, Math.max(AI_MESSAGES_MIN, Math.floor(Number(e.target.value) || AI_MESSAGES_DEFAULT))))
        }
        className={cn("w-24", INPUT)}
      />
    </Field>
  )
}

function LanguageSelect({
  value,
  onChange,
  emptyLabel,
}: {
  value: string
  onChange: (v: string) => void
  emptyLabel: string
}) {
  const locale = useLocale()
  const options = useMemo(() => languageOptions(locale), [locale])
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={SELECT}>
      <option value="">{emptyLabel}</option>
      {options.map((o) => (
        <option key={o.code} value={o.code}>
          {o.name}
        </option>
      ))}
    </select>
  )
}

// ------------------------------------------------------------
// AI reply
// ------------------------------------------------------------

export function AiReplyEditor({ cid, config, set }: EditorProps) {
  const t = useTranslations("Automations.builder.ai")
  const mode = (config.mode as string) === "draft" ? "draft" : "send"
  const onFailure = (config.on_failure as string) ?? "skip"
  return (
    <>
      <AiNotices cid={cid} />
      <Field label={t("reply.mode")}>
        <select value={mode} onChange={(e) => set({ mode: e.target.value })} className={SELECT}>
          <option value="send">{t("reply.modeSend")}</option>
          <option value="draft">{t("reply.modeDraft")}</option>
        </select>
      </Field>
      <PromptField
        cid={cid}
        label={t("reply.instructions")}
        value={(config.instructions as string) ?? ""}
        onChange={(v) => set({ instructions: v })}
        placeholder={t("reply.instructionsPlaceholder")}
        hint={t("reply.instructionsHint")}
      />
      <Field label={t("reply.language")}>
        <LanguageSelect
          value={(config.language as string) && config.language !== "match" ? (config.language as string) : ""}
          onChange={(v) => set({ language: v || "match" })}
          emptyLabel={t("reply.languageMatch")}
        />
      </Field>
      {mode === "send" && (
        <Check
          checked={config.even_if_assigned === true}
          onChange={(v) => set({ even_if_assigned: v })}
          label={t("reply.evenIfAssigned")}
          hint={t("reply.evenIfAssignedHint")}
        />
      )}
      <OnFailureField
        value={onFailure}
        onChange={(v) => set({ on_failure: v })}
        allow={["skip", "stop", "fallback"]}
        fallbackText={(config.fallback_text as string) ?? ""}
        onFallbackText={(v) => set({ fallback_text: v })}
      />
      <p className="text-[11px] text-muted-foreground">{t("reply.branchesHint")}</p>
    </>
  )
}

// ------------------------------------------------------------
// Ask AI (yes/no): the fields of a Condition whose subject is ai_question
// ------------------------------------------------------------

export function AskAiFields({ cid, config, set }: EditorProps) {
  const t = useTranslations("Automations.builder.ai")
  return (
    <>
      <AiNotices cid={cid} />
      <PromptField
        cid={cid}
        label={t("ask.question")}
        value={(config.operand as string) ?? ""}
        onChange={(v) => set({ operand: v })}
        placeholder={t("ask.questionPlaceholder")}
        hint={t("ask.unsureHint")}
        rows={2}
      />
      <MessagesCountField value={config.ai_messages} onChange={(n) => set({ ai_messages: n })} />
      <OnFailureField
        value={(config.on_failure as string) === "stop" ? "stop" : "no"}
        onChange={(v) => set({ on_failure: v })}
        allow={["no", "stop"]}
      />
    </>
  )
}

// ------------------------------------------------------------
// AI classify and extract
// ------------------------------------------------------------

const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/

type TargetChoice = "vars" | "name" | "email" | "company" | "custom" | "label" | "tag"

function targetChoiceOf(f: AiExtractField): TargetChoice {
  const t = f.target
  if (!t) return "vars"
  if (t.kind === "contact_field") return t.field
  if (t.kind === "custom_field") return "custom"
  return t.kind
}

function blankField(existing: AiExtractField[]): AiExtractField {
  let n = existing.length + 1
  while (existing.some((f) => f.key === `field_${n}`)) n += 1
  return { key: `field_${n}`, description: "", type: "text" }
}

export function AiExtractEditor({ cid, config, set, slots }: EditorProps) {
  const t = useTranslations("Automations.builder.ai")
  const fields = (Array.isArray(config.fields) ? config.fields : []) as AiExtractField[]
  const setFields = (next: AiExtractField[]) => set({ fields: next })
  const patchField = (i: number, patch: Partial<AiExtractField>) =>
    setFields(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)))
  const full = fields.length >= AI_EXTRACT_MAX_FIELDS

  function addPreset(kind: "sentiment" | "topic") {
    if (full) return
    const key = kind
    if (fields.some((f) => f.key === key)) return
    const preset: AiExtractField =
      kind === "sentiment"
        ? {
            key,
            description: t("extract.presetSentimentDescription"),
            type: "choice",
            choices: ["positive", "neutral", "negative"],
          }
        : {
            key,
            description: t("extract.presetTopicDescription"),
            type: "choice",
            choices: ["billing", "shipping", "technical", "other"],
          }
    set({ fields: [...fields, preset], preset: kind })
  }

  return (
    <>
      <AiNotices cid={cid} />
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t("extract.presets")}</span>
        <Button type="button" variant="outline" size="sm" disabled={full} onClick={() => addPreset("sentiment")}>
          {t("extract.presetSentiment")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={full} onClick={() => addPreset("topic")}>
          {t("extract.presetTopic")}
        </Button>
      </div>

      <ul className="space-y-3">
        {fields.map((f, i) => (
          <li key={i} className="rounded-md border border-border bg-background/40 p-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("extract.key")}>
                <Input
                  value={f.key}
                  onChange={(e) => patchField(i, { key: e.target.value })}
                  aria-invalid={!KEY_RE.test(f.key)}
                  className={cn("font-mono", INPUT)}
                />
              </Field>
              <Field label={t("extract.type")}>
                <select
                  value={f.type}
                  onChange={(e) => {
                    const type = e.target.value as AiFieldType
                    // A label or tag target only makes sense for a choice.
                    const target = type !== "choice" && (f.target?.kind === "label" || f.target?.kind === "tag") ? null : f.target
                    patchField(i, { type, target, choices: type === "choice" ? (f.choices ?? []) : undefined })
                  }}
                  className={SELECT}
                >
                  {(["text", "number", "date", "boolean", "choice"] as AiFieldType[]).map((ty) => (
                    <option key={ty} value={ty}>
                      {t(`extract.types.${ty}`)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={t("extract.description")}>
              <Input
                value={f.description}
                onChange={(e) => patchField(i, { description: e.target.value })}
                placeholder={t("extract.descriptionPlaceholder")}
                className={INPUT}
              />
            </Field>
            {f.type === "choice" && <ChoicesInput field={f} onChange={(choices) => patchField(i, { choices })} />}
            <Field label={t("extract.target")}>
              <select
                value={targetChoiceOf(f)}
                onChange={(e) => {
                  const v = e.target.value as TargetChoice
                  const target: AiExtractField["target"] =
                    v === "vars"
                      ? null
                      : v === "name" || v === "email" || v === "company"
                        ? { kind: "contact_field", field: v }
                        : v === "custom"
                          ? { kind: "custom_field", custom_field_id: slots.customFields[0]?.id ?? "" }
                          : { kind: v }
                  patchField(i, { target })
                }}
                className={SELECT}
              >
                <option value="vars">{t("extract.targets.vars")}</option>
                <option value="name">{t("extract.targets.name")}</option>
                <option value="email">{t("extract.targets.email")}</option>
                <option value="company">{t("extract.targets.company")}</option>
                {slots.customFields.length > 0 && <option value="custom">{t("extract.targets.custom")}</option>}
                {f.type === "choice" && <option value="label">{t("extract.targets.label")}</option>}
                {f.type === "choice" && <option value="tag">{t("extract.targets.tag")}</option>}
              </select>
            </Field>
            {f.target?.kind === "custom_field" && (
              <Field label={t("extract.customField")}>
                <select
                  value={f.target.custom_field_id}
                  onChange={(e) => patchField(i, { target: { kind: "custom_field", custom_field_id: e.target.value } })}
                  className={SELECT}
                >
                  {slots.customFields.map((cf) => (
                    <option key={cf.id} value={cf.id}>
                      {cf.field_name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {(f.target?.kind === "label" || f.target?.kind === "tag") && (
              <p className="mb-2 text-[11px] text-muted-foreground">{t("extract.existingOnly")}</p>
            )}
            <div className="flex items-center justify-between">
              <code className="text-[11px] text-muted-foreground">{`{{ vars.${f.key} }}`}</code>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setFields(fields.filter((_, idx) => idx !== i))}
                aria-label={t("extract.removeField")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        disabled={full}
        onClick={() => setFields([...fields, blankField(fields)])}
      >
        <Plus className="h-3.5 w-3.5" />
        {t("extract.addField")}
      </Button>
      <p className="mt-1 text-[11px] text-muted-foreground">{t("extract.fieldsLimit", { max: AI_EXTRACT_MAX_FIELDS })}</p>

      <div className="mt-3">
        <Check
          checked={config.overwrite === true}
          onChange={(v) => set({ overwrite: v })}
          label={t("extract.overwrite")}
          hint={t("extract.overwriteHint")}
        />
        <PromptField
          cid={cid}
          label={t("extract.instructions")}
          value={(config.instructions as string) ?? ""}
          onChange={(v) => set({ instructions: v })}
          placeholder={t("extract.instructionsPlaceholder")}
          rows={2}
        />
        <MessagesCountField value={config.ai_messages} onChange={(n) => set({ ai_messages: n })} />
        <OnFailureField
          value={(config.on_failure as string) ?? "stop"}
          onChange={(v) => set({ on_failure: v })}
          allow={["stop", "skip"]}
        />
      </div>
    </>
  )
}

function ChoicesInput({ field, onChange }: { field: AiExtractField; onChange: (c: string[]) => void }) {
  const t = useTranslations("Automations.builder.ai")
  // A local draft so commas and trailing spaces survive typing (same pattern
  // as the keyword box); parsed into the list on blur.
  const [draft, setDraft] = useState((field.choices ?? []).join(", "))
  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, AI_EXTRACT_MAX_CHOICES)
    setDraft(parsed.join(", "))
    onChange(parsed)
  }
  return (
    <Field label={t("extract.choices")} hint={t("extract.choicesHint", { max: AI_EXTRACT_MAX_CHOICES })}>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          }
        }}
        className={INPUT}
      />
    </Field>
  )
}

// ------------------------------------------------------------
// AI summarise, AI translate
// ------------------------------------------------------------

function SaveToField({
  value,
  onChange,
  fallback,
}: {
  value: unknown
  onChange: (v: string) => void
  fallback: string
}) {
  const t = useTranslations("Automations.builder.ai")
  const v = typeof value === "string" ? value : ""
  return (
    <Field label={t("saveTo")} hint={t("saveToHint", { key: v && KEY_RE.test(v) ? v : fallback })}>
      <Input
        value={v}
        onChange={(e) => onChange(e.target.value.toLowerCase())}
        placeholder={fallback}
        aria-invalid={v !== "" && !KEY_RE.test(v)}
        className={cn("font-mono", INPUT)}
      />
    </Field>
  )
}

export function AiSummarizeEditor({ cid, config, set }: EditorProps) {
  const t = useTranslations("Automations.builder.ai")
  return (
    <>
      <AiNotices cid={cid} />
      <p className="mb-2 text-[11px] text-muted-foreground">{t("summarize.hint")}</p>
      <SaveToField value={config.save_to} onChange={(v) => set({ save_to: v })} fallback="summary" />
      <Check
        checked={config.post_note === true}
        onChange={(v) => set({ post_note: v })}
        label={t("summarize.postNote")}
      />
      <Field label={t("summarize.language")}>
        <LanguageSelect
          value={(config.language as string) ?? ""}
          onChange={(v) => set({ language: v })}
          emptyLabel={t("summarize.languageDefault")}
        />
      </Field>
      <OnFailureField
        value={(config.on_failure as string) ?? "stop"}
        onChange={(v) => set({ on_failure: v })}
        allow={["stop", "skip"]}
      />
    </>
  )
}

export function AiTranslateEditor({ cid, config, set }: EditorProps) {
  const t = useTranslations("Automations.builder.ai")
  return (
    <>
      <AiNotices cid={cid} />
      <PromptField
        cid={cid}
        label={t("translate.source")}
        value={(config.source as string) ?? ""}
        onChange={(v) => set({ source: v })}
        placeholder={t("translate.sourcePlaceholder")}
        hint={t("translate.sourceHint")}
        rows={2}
      />
      <Field label={t("translate.target")}>
        <LanguageSelect
          value={(config.target_language as string) ?? ""}
          onChange={(v) => set({ target_language: v })}
          emptyLabel={t("translate.targetPlaceholder")}
        />
      </Field>
      <SaveToField value={config.save_to} onChange={(v) => set({ save_to: v })} fallback="translation" />
      <OnFailureField
        value={(config.on_failure as string) ?? "stop"}
        onChange={(v) => set({ on_failure: v })}
        allow={["stop", "skip"]}
      />
    </>
  )
}

// ------------------------------------------------------------
// Create ticket
// ------------------------------------------------------------

const TICKET_TYPES = ["bug", "feature_request", "technical", "billing", "account", "general", "other"]

export function CreateTicketEditor({ cid, config, set, slots }: EditorProps) {
  const t = useTranslations("Automations.builder.ai")
  const tType = useTranslations("Tickets.common.type")
  const aiWrite = config.ai_write === true
  return (
    <>
      {aiWrite && <AiNotices cid={cid} />}
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("ticket.type")}>
          <select
            value={(config.category as string) ?? "general"}
            onChange={(e) => set({ category: e.target.value })}
            className={SELECT}
          >
            {TICKET_TYPES.map((k) => (
              <option key={k} value={k}>
                {tType(k)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("ticket.priority")}>
          <select
            value={(config.priority as string) ?? "normal"}
            onChange={(e) => set({ priority: e.target.value })}
            className={SELECT}
          >
            {(["urgent", "high", "normal", "low"] as const).map((k) => (
              <option key={k} value={k}>
                {slots.tBuilder(`config.priorities.${k}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={t("ticket.team")}>
        <slots.TeamSelect
          value={(config.assigned_team_id as string) ?? ""}
          onChange={(v) => set({ assigned_team_id: v || null })}
          t={slots.tBuilder}
        />
      </Field>
      <Field label={t("ticket.agent")}>
        <slots.AgentSelect
          value={(config.assigned_agent_id as string) ?? ""}
          onChange={(v) => set({ assigned_agent_id: v || null })}
          t={slots.tBuilder}
        />
      </Field>
      <PromptField
        cid={cid}
        single
        label={t("ticket.subject")}
        value={(config.subject as string) ?? ""}
        onChange={(v) => set({ subject: v })}
        placeholder={t("ticket.subjectPlaceholder")}
        hint={aiWrite ? t("ticket.subjectFallbackHint") : undefined}
      />
      <PromptField
        cid={cid}
        label={t("ticket.description")}
        value={(config.description as string) ?? ""}
        onChange={(v) => set({ description: v })}
        placeholder={t("ticket.descriptionPlaceholder")}
      />
      <Check
        checked={aiWrite}
        onChange={(v) => set({ ai_write: v })}
        label={t("ticket.aiWrite")}
        hint={t("ticket.aiWriteHint")}
      />
      <Check
        checked={config.skip_if_open !== false}
        onChange={(v) => set({ skip_if_open: v })}
        label={t("ticket.skipIfOpen")}
      />
    </>
  )
}

// ------------------------------------------------------------
// Test this step
// ------------------------------------------------------------

interface PickerConversation {
  id: string
  status: string
  name: string
  preview: string
}

export function TestStepPanel({
  stepType,
  config,
}: {
  stepType: string
  config: Record<string, unknown>
}) {
  const t = useTranslations("Automations.builder.ai.test")
  const tErr = useTranslations("Automations.builder.ai.test.errors")
  const flow = useContext(FlowContext)
  // The test route needs ai.use on top of automations.manage.
  const canUseAi = useCapability("ai.use")
  const canManage = useCapability("automations.manage")
  const canTest = canUseAi && canManage
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [list, setList] = useState<PickerConversation[] | null>(null)
  const [picked, setPicked] = useState<PickerConversation | null>(null)
  const [samples, setSamples] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TestStepResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Sample values for the `{{ vars.x }}` the step uses (they come from earlier steps).
  const referenced = useMemo(() => {
    const found = new Set<string>()
    for (const m of JSON.stringify(config).matchAll(/\{\{\s*vars\.([a-z][a-z0-9_]*)\s*\}\}/g)) found.add(m[1])
    return [...found]
  }, [config])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/automations/test-ai-step/conversations?q=${encodeURIComponent(q)}`, {
          cache: "no-store",
        })
        const json = (await res.json().catch(() => ({}))) as { conversations?: PickerConversation[] }
        if (!cancelled) setList(res.ok ? (json.conversations ?? []) : [])
      } catch {
        if (!cancelled) setList([])
      }
    }, q ? 250 : 0)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [open, q])

  async function run() {
    if (!picked) return
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch("/api/automations/test-ai-step", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          step: { step_type: stepType, step_config: config },
          conversation_id: picked.id,
          vars: samples,
          trigger_type: flow.triggerType,
        }),
      })
      const json = (await res.json().catch(() => ({}))) as { result?: TestStepResponse; error?: string; code?: string }
      if (!res.ok || !json.result) {
        setError(json.code && tErr.has(json.code) ? tErr(json.code) : (json.error ?? tErr("generic")))
      } else {
        setResult(json.result)
      }
    } catch {
      setError(tErr("generic"))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="mt-3 rounded-md border border-dashed border-border p-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        disabled={!canTest}
        title={canTest ? undefined : t("needsAiUse")}
        aria-expanded={open}
      >
        <Play className="h-3.5 w-3.5" />
        {t("button")}
      </Button>
      {!canTest && <p className="mt-1 text-[11px] text-muted-foreground">{t("needsAiUse")}</p>}

      {open && canTest && (
        <div className="mt-3 space-y-3">
          <p className="text-[11px] text-muted-foreground">{t("intro")}</p>

          <Field label={t("pickConversation")}>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchPlaceholder")}
              className={INPUT}
            />
            <ul
              className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border bg-background/40"
              role="listbox"
              aria-label={t("pickConversation")}
            >
              {list === null && (
                <li className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("loading")}
                </li>
              )}
              {list?.length === 0 && <li className="px-2 py-2 text-xs text-muted-foreground">{t("noConversations")}</li>}
              {list?.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={picked?.id === c.id}
                    onClick={() => {
                      setPicked(c)
                      setResult(null)
                      setError(null)
                    }}
                    className={cn(
                      "block w-full px-2 py-1.5 text-left text-xs hover:bg-muted",
                      picked?.id === c.id && "bg-primary/10",
                    )}
                  >
                    <span className="block truncate font-medium text-foreground">{c.name || t("unknownContact")}</span>
                    <span className="block truncate text-muted-foreground">{c.preview || "-"}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Field>

          {referenced.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">{t("samples")}</p>
              {referenced.map((k) => (
                <div key={k} className="mb-1 flex items-center gap-2">
                  <code className="w-28 shrink-0 truncate text-[11px] text-muted-foreground">{`vars.${k}`}</code>
                  <Input
                    value={samples[k] ?? ""}
                    onChange={(e) => setSamples((s) => ({ ...s, [k]: e.target.value }))}
                    aria-label={`vars.${k}`}
                    className={cn("h-7", INPUT)}
                  />
                </div>
              ))}
            </div>
          )}

          <Button type="button" size="sm" onClick={run} disabled={!picked || running}>
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {running ? t("running") : t("run")}
          </Button>

          {error && (
            <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-300">
              {error}
            </p>
          )}
          {result && <TestResult stepType={stepType} result={result} />}
        </div>
      )}
    </div>
  )
}

/** What a test showed. Pure display: exported for the render tests. */
export function TestResult({ stepType, result }: { stepType: string; result: TestStepResponse }) {
  const t = useTranslations("Automations.builder.ai.test")
  const tErr = useTranslations("Automations.builder.ai.test.errors")
  const isBranching = stepType === "ai_reply" || stepType === "condition"
  const branchLabel =
    stepType === "ai_reply"
      ? result.branch === "yes"
        ? t("branchAnswered")
        : t("branchCouldnt")
      : result.branch === "yes"
        ? t("branchYes")
        : t("branchNo")

  return (
    <div className="space-y-2 rounded-md border border-border bg-background/60 p-2 text-xs" data-testid="ai-test-result">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[11px] font-medium",
            result.failure
              ? "border-red-500/30 bg-red-500/10 text-red-300"
              : "border-primary/30 bg-primary/10 text-primary",
          )}
        >
          {t(`outcomes.${result.failure ? "failed" : result.outcome}`)}
        </span>
        {isBranching && result.branch && (
          <span className="text-muted-foreground">{t("goesTo", { branch: branchLabel })}</span>
        )}
        <span className="ml-auto tabular-nums text-muted-foreground">{t("tokens", { count: result.tokens })}</span>
      </div>

      {result.failure && (
        <p className="text-red-300">
          {tErr.has(result.failure.code) ? tErr(result.failure.code) : result.failure.message}
        </p>
      )}
      {result.reason && !result.failure && (
        <p className="text-muted-foreground">
          {stepType === "condition" ? t("reason") : t("why")}: {tReason(t, result.reason)}
        </p>
      )}
      {result.json && Object.keys(result.json).length > 0 && (
        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[11px] text-foreground">
          {JSON.stringify(result.json, null, 2)}
        </pre>
      )}
      {result.ticket && (
        <div className="space-y-1">
          <p className="font-medium text-foreground">{result.ticket.subject}</p>
          {result.ticket.description && (
            <p className="whitespace-pre-wrap text-muted-foreground">{result.ticket.description}</p>
          )}
          {result.ticket.skip === "open_ticket_exists" && <p className="text-amber-300">{t("ticketSkipped")}</p>}
        </div>
      )}
      {!result.ticket && result.text && !result.json && (
        <p className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-foreground">{result.text}</p>
      )}
      {result.notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
          {result.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {result.wouldDo.length > 0 && (
        <div>
          <p className="mb-0.5 font-medium text-foreground">{t("wouldDo")}</p>
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
            {result.wouldDo.map((w, i) => (
              <li key={i}>
                {t(`would.${w.kind}`, { name: w.name ?? "", text: (w.text ?? "").slice(0, 80) })}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">{t("nothingChanged")}</p>
    </div>
  )
}

function tReason(t: ReturnType<typeof useTranslations>, reason: string): string {
  // Machine reasons the AI reply gives when it does not answer; anything else is the model's own words.
  const known = ["ai_paused", "agent_assigned", "nothing_to_reply_to", "no_knowledge", "handoff", "empty", "no_messages", "open_ticket_exists", "sent", "draft_note"]
  return known.includes(reason) ? t(`reasons.${reason}`) : reason
}
