"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { createClient } from "@/lib/supabase/client"
import { SIGN_EVENT_NAMES, eventsOf } from "@/lib/automations/sign-event"
import { MAX_COPY_RECIPIENTS, MAX_SIGN_RECIPIENTS, isCopyRecipient, requiredRoleKeys } from "@/lib/automations/sign-step"
import { SIGN_LOCALES, type SignRole } from "@/lib/sign/types"
import type { PlacedField } from "@/lib/sign/pdf/types"
import type { FormDefinition } from "@/lib/sign/forms/types"
import type { SendSignDocumentRecipient, SignDocumentEventTriggerConfig, SignEventName } from "@/types"
import { PromptField } from "./ai-steps"

// ------------------------------------------------------------
// The Doc Sign parts of the automation builder: the "Doc Sign event" trigger panel and the editor of the
// "Send a document for signing" step. Kept out of automation-builder.tsx like the AI editors are.
//
// Templates and categories are read with the browser client through row level security (menu.sign), the same
// way the Doc Sign screens read them. A person without that capability gets empty lists and the pickers fall
// back to a plain id box, so an automation can still be opened and saved.
// ------------------------------------------------------------

const SELECT =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
const INPUT = "bg-muted text-foreground"

interface SignTemplateOption {
  id: string
  name: string
  status: string
  category_id: string | null
  current_version_id: string | null
}
interface SignCategoryOption {
  id: string
  name: string
}
interface SignResources {
  templates: SignTemplateOption[]
  categories: SignCategoryOption[]
  /** The lists have been read (an empty list then means there are none, or no access). */
  loaded: boolean
}

/** Exported so tests can render the pickers with templates without a fetch. */
export const SignResourcesContext = createContext<SignResources>({ templates: [], categories: [], loaded: false })

/** Reads the active templates and the categories once, and only when the automation uses Doc Sign. */
export function SignResourcesProvider({ needed, children }: { needed: boolean; children: ReactNode }) {
  const [value, setValue] = useState<SignResources>({ templates: [], categories: [], loaded: false })
  const started = useRef(false)
  useEffect(() => {
    if (!needed || started.current) return
    started.current = true
    let cancelled = false
    const supabase = createClient()
    void (async () => {
      try {
        const [tpl, cat] = await Promise.all([
          supabase.from("sign_templates").select("id, name, status, category_id, current_version_id").eq("status", "active").order("name"),
          supabase.from("sign_categories").select("id, name").eq("archived", false).order("position", { ascending: true }),
        ])
        if (cancelled) return
        setValue({
          templates: (tpl.data as SignTemplateOption[] | null) ?? [],
          categories: (cat.data as SignCategoryOption[] | null) ?? [],
          loaded: true,
        })
      } catch {
        if (!cancelled) setValue((v) => ({ ...v, loaded: true }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [needed])
  return <SignResourcesContext.Provider value={value}>{children}</SignResourcesContext.Provider>
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

// ------------------------------------------------------------
// Trigger: when a document is sent / viewed / completed / declined / expired / voided
// ------------------------------------------------------------

export function SignTriggerConfig({
  config,
  onChange,
}: {
  config: SignDocumentEventTriggerConfig & Record<string, unknown>
  onChange: (c: Record<string, unknown>) => void
}) {
  const t = useTranslations("Automations.builder.sign.trigger")
  const { templates, categories } = useContext(SignResourcesContext)
  // Nothing ticked means "completed only": show that as the ticked box so what you see is what runs.
  const chosen = eventsOf(config)
  const set = (patch: Record<string, unknown>) => onChange({ ...config, ...patch })

  // A recipe names the template it is for ("Merchant Application"): pick it when the workspace has it.
  const hint = typeof config.template_hint === "string" ? config.template_hint : ""
  const hinted = hint ? templates.find((x) => x.name.trim().toLowerCase() === hint.trim().toLowerCase()) : undefined
  useEffect(() => {
    if (!config.template_id && hinted) onChange({ ...config, template_id: hinted.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.template_id, hinted?.id])

  function toggle(ev: SignEventName, on: boolean) {
    const next = on ? [...chosen, ev] : chosen.filter((x) => x !== ev)
    // keep the document's own order, and never leave the list empty (that would silently mean "completed")
    const ordered = SIGN_EVENT_NAMES.filter((x) => next.includes(x))
    set({ events: ordered.length > 0 ? ordered : chosen })
  }

  return (
    <div className="space-y-3">
      <Field label={t("events")} hint={t("eventsHint")}>
        <div className="space-y-1">
          {SIGN_EVENT_NAMES.map((ev) => (
            <label key={ev} className="flex items-center gap-2 text-xs text-foreground">
              <input type="checkbox" checked={chosen.includes(ev)} onChange={(e) => toggle(ev, e.target.checked)} className="h-3.5 w-3.5" />
              {t(`event.${ev}`)}
            </label>
          ))}
        </div>
      </Field>
      <Field label={t("template")}>
        {templates.length === 0 ? (
          <Input value={(config.template_id as string) ?? ""} onChange={(e) => set({ template_id: e.target.value })} placeholder={t("templateId")} className={INPUT} />
        ) : (
          <select value={(config.template_id as string) ?? ""} onChange={(e) => set({ template_id: e.target.value })} className={SELECT}>
            <option value="">{t("anyTemplate")}</option>
            {templates.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
            {config.template_id && !templates.some((x) => x.id === config.template_id) && <option value={config.template_id as string}>{t("unknownTemplate")}</option>}
          </select>
        )}
      </Field>
      {categories.length > 0 && (
        <Field label={t("category")}>
          <select value={(config.category_id as string) ?? ""} onChange={(e) => set({ category_id: e.target.value })} className={SELECT}>
            <option value="">{t("anyCategory")}</option>
            {categories.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
      )}
    </div>
  )
}

// ------------------------------------------------------------
// Step: Send a document for signing
// ------------------------------------------------------------

interface TemplateVersion {
  roles: SignRole[]
  fields: PlacedField[]
  form: FormDefinition | null
}

/** The roles, merge fields and required roles of a template's current version (one small read per template picked). */
function useTemplateVersion(versionId: string | null | undefined): TemplateVersion | null {
  const [state, setState] = useState<{ id: string; v: TemplateVersion | null } | null>(null)
  useEffect(() => {
    if (!versionId) return
    let cancelled = false
    void (async () => {
      try {
        const { data } = await createClient().from("sign_template_versions").select("roles, fields, form").eq("id", versionId).maybeSingle()
        if (!cancelled) setState({ id: versionId, v: (data as TemplateVersion | null) ?? null })
      } catch {
        if (!cancelled) setState({ id: versionId, v: null })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [versionId])
  return versionId && state?.id === versionId ? state.v : null
}

interface EditorProps {
  cid: string
  config: Record<string, unknown>
  set: (patch: Record<string, unknown>) => void
}

const blankRecipient = (roleKey = ""): SendSignDocumentRecipient => ({ role_key: roleKey, source: "contact", channel: "email" })
/** Someone who only receives the signed copy: no role, no channel (the shape keeps "" and "email"), usually a fixed person. */
const blankCopy = (): SendSignDocumentRecipient => ({ kind: "copy", role_key: "", source: "fixed", channel: "email" })

export function SendSignDocumentEditor({ cid, config, set }: EditorProps) {
  const t = useTranslations("Automations.builder.sign.step")
  const { templates, loaded } = useContext(SignResourcesContext)
  const templateId = typeof config.template_id === "string" ? config.template_id : ""
  const template = templates.find((x) => x.id === templateId)
  const version = useTemplateVersion(template?.current_version_id)
  const recipients = (Array.isArray(config.recipients) ? config.recipients : []) as SendSignDocumentRecipient[]
  const merge = (config.merge_values && typeof config.merge_values === "object" ? config.merge_values : {}) as Record<string, string>
  const mergeRows = Object.entries(merge)

  // A recipe names the template it expects ("Merchant Application"): pick it when the workspace has it.
  const hint = typeof config.template_hint === "string" ? config.template_hint : ""
  const hinted = useMemo(
    () => (hint ? templates.find((x) => x.name.trim().toLowerCase() === hint.trim().toLowerCase()) : undefined),
    [hint, templates],
  )
  useEffect(() => {
    if (!templateId && hinted) set({ template_id: hinted.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, hinted?.id])

  const roles = version?.roles ?? []
  const required = useMemo(() => (version ? requiredRoleKeys(version) : []), [version])
  const signers = recipients.filter((r) => !isCopyRecipient(r))
  const copyCount = recipients.length - signers.length
  const uncovered = required.filter((k) => !signers.some((r) => r.role_key === k))
  const mergeKeys = useMemo(() => [...new Set((version?.fields ?? []).map((f) => f.merge).filter((m): m is string => !!m))], [version])
  const listId = `sign-merge-${cid}`

  function patchRecipient(i: number, patch: Partial<SendSignDocumentRecipient>) {
    set({ recipients: recipients.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  }
  /** Change what a person is: a copy has no role, no channel and no phone; a signer is the default kind (left off). */
  function setKind(i: number, kind: "signer" | "copy") {
    patchRecipient(
      i,
      kind === "copy"
        ? { kind: "copy", role_key: "", channel: "email", phone: undefined }
        : { kind: undefined, role_key: uncovered[0] ?? "" },
    )
  }
  function setMerge(rows: [string, string][]) {
    set({ merge_values: Object.fromEntries(rows) })
  }
  function patchMergeRow(i: number, key: string, value: string) {
    const rows = mergeRows.map((r, j): [string, string] => (j === i ? [key, value] : r))
    setMerge(rows)
  }

  return (
    <>
      <Field label={t("template")}>
        {templates.length === 0 ? (
          <>
            <Input value={templateId} onChange={(e) => set({ template_id: e.target.value })} placeholder={t("templateId")} className={INPUT} />
            {loaded && <p className="mt-1 text-[11px] text-amber-300">{t("noTemplates")}</p>}
            {hint && !templateId && <p className="mt-1 text-[11px] text-muted-foreground">{t("templateHint", { name: hint })}</p>}
          </>
        ) : (
          <>
            <select value={templateId} onChange={(e) => set({ template_id: e.target.value })} className={SELECT}>
              <option value="">{t("selectTemplate")}</option>
              {templates.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
              {templateId && !template && <option value={templateId}>{t("unknownTemplate")}</option>}
            </select>
            {hint && !templateId && <p className="mt-1 text-[11px] text-muted-foreground">{t("templateHint", { name: hint })}</p>}
          </>
        )}
      </Field>

      <PromptField cid={cid} single label={t("title")} value={(config.title as string) ?? ""} onChange={(v) => set({ title: v })} hint={t("titleHint")} />

      <Field label={t("recipients")} hint={t("recipientsHint")}>
        <div className="space-y-2">
          {recipients.map((r, i) => {
            const copy = isCopyRecipient(r)
            return (
              <div key={i} className="rounded-md border border-border bg-card/60 p-2">
                <div className="mb-2 flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <label className="mb-1 block text-[11px] text-muted-foreground">{t("type")}</label>
                    <select value={copy ? "copy" : "signer"} onChange={(e) => setKind(i, e.target.value as "signer" | "copy")} className={SELECT}>
                      <option value="signer">{t("typeSigner")}</option>
                      <option value="copy">{t("typeCopy")}</option>
                    </select>
                  </div>
                  {!copy && (
                    <div className="min-w-0 flex-1">
                      <label className="mb-1 block text-[11px] text-muted-foreground">{t("role")}</label>
                      {roles.length > 0 ? (
                        <select value={r.role_key} onChange={(e) => patchRecipient(i, { role_key: e.target.value })} className={SELECT}>
                          <option value="">{t("selectRole")}</option>
                          {roles.map((x) => (
                            <option key={x.key} value={x.key}>
                              {x.label}
                              {required.includes(x.key) ? " *" : ""}
                            </option>
                          ))}
                          {r.role_key && !roles.some((x) => x.key === r.role_key) && <option value={r.role_key}>{r.role_key}</option>}
                        </select>
                      ) : (
                        <Input value={r.role_key} onChange={(e) => patchRecipient(i, { role_key: e.target.value })} placeholder={t("rolePlaceholder")} className={INPUT} />
                      )}
                    </div>
                  )}
                  <Button type="button" variant="ghost" size="icon" aria-label={t("removeRecipient")} onClick={() => set({ recipients: recipients.filter((_, j) => j !== i) })}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-[11px] text-muted-foreground">{t("source")}</label>
                    <select value={r.source} onChange={(e) => patchRecipient(i, { source: e.target.value as "contact" | "fixed" })} className={SELECT}>
                      <option value="contact">{t("sourceContact")}</option>
                      <option value="fixed">{t("sourceFixed")}</option>
                    </select>
                  </div>
                  {!copy && (
                    <div>
                      <label className="mb-1 block text-[11px] text-muted-foreground">{t("channel")}</label>
                      <select value={r.channel} onChange={(e) => patchRecipient(i, { channel: e.target.value as "email" | "whatsapp" })} className={SELECT}>
                        <option value="email">{t("channelEmail")}</option>
                        <option value="whatsapp">{t("channelWhatsapp")}</option>
                      </select>
                    </div>
                  )}
                </div>
                {r.source === "contact" ? (
                  <p className="mt-2 text-[11px] text-muted-foreground">{copy ? t("contactCopyNote") : t("contactNote")}</p>
                ) : (
                  <div className="mt-2 space-y-1">
                    <PromptField cid={cid} single label={t("fullName")} value={r.full_name ?? ""} onChange={(v) => patchRecipient(i, { full_name: v })} />
                    <PromptField cid={cid} single label={t("email")} value={r.email ?? ""} onChange={(v) => patchRecipient(i, { email: v })} />
                    {!copy && r.channel === "whatsapp" && <PromptField cid={cid} single label={t("phone")} value={r.phone ?? ""} onChange={(v) => patchRecipient(i, { phone: v })} />}
                  </div>
                )}
              </div>
            )
          })}
          {uncovered.length > 0 && (
            <p role="alert" className="text-[11px] text-amber-300">
              {t("requiredRoles", { roles: uncovered.map((k) => roles.find((x) => x.key === k)?.label ?? k).join(", ") })}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={signers.length >= MAX_SIGN_RECIPIENTS}
              onClick={() => set({ recipients: [...recipients, blankRecipient(uncovered[0] ?? "")] })}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("addRecipient")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={copyCount >= MAX_COPY_RECIPIENTS}
              onClick={() => set({ recipients: [...recipients, blankCopy()] })}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("addCopy")}
            </Button>
          </div>
        </div>
      </Field>

      <Field label={t("merge")} hint={t("mergeHint")}>
        <div className="space-y-2">
          {mergeKeys.length > 0 && <datalist id={listId}>{mergeKeys.map((k) => <option key={k} value={k} />)}</datalist>}
          {mergeRows.map(([k, v], i) => (
            <div key={i} className="rounded-md border border-border bg-card/60 p-2">
              <div className="mb-1 flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <label className="mb-1 block text-[11px] text-muted-foreground">{t("mergeKey")}</label>
                  <Input value={k} list={mergeKeys.length > 0 ? listId : undefined} onChange={(e) => patchMergeRow(i, e.target.value, v)} className={INPUT} />
                </div>
                <Button type="button" variant="ghost" size="icon" aria-label={t("removeMerge")} onClick={() => setMerge(mergeRows.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <PromptField cid={cid} single label={t("mergeValue")} value={v} onChange={(nv) => patchMergeRow(i, k, nv)} />
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setMerge([...mergeRows, [nextMergeKey(mergeKeys, mergeRows), ""]])}>
            <Plus className="h-3.5 w-3.5" />
            {t("addMerge")}
          </Button>
        </div>
      </Field>

      <PromptField cid={cid} label={t("message")} value={(config.message as string) ?? ""} onChange={(v) => set({ message: v })} rows={2} />

      <Field label={t("language")}>
        <select value={(config.locale as string) ?? ""} onChange={(e) => set({ locale: e.target.value || undefined })} className={SELECT}>
          <option value="">{t("languageDefault")}</option>
          {SIGN_LOCALES.map((l) => (
            <option key={l} value={l}>
              {t(`languages.${l}`)}
            </option>
          ))}
        </select>
      </Field>

      <div className="mb-2 last:mb-0">
        <label className="flex items-start gap-2 text-xs text-foreground">
          <input type="checkbox" checked={config.send !== false} onChange={(e) => set({ send: e.target.checked })} className="mt-0.5 h-3.5 w-3.5" />
          <span>{t("send")}</span>
        </label>
        <p className="ml-5 mt-0.5 text-[11px] text-muted-foreground">{t("sendHint")}</p>
      </div>
    </>
  )
}

/** A name for a new merge row: the first of the template's merge fields not used yet, else a placeholder the person renames. */
function nextMergeKey(mergeKeys: string[], rows: [string, string][]): string {
  const used = new Set(rows.map(([k]) => k))
  const free = mergeKeys.find((k) => !used.has(k))
  if (free) return free
  let n = rows.length + 1
  while (used.has(`field${n}`)) n++
  return `field${n}`
}
