"use client";

// ============================================================
// Compliance requests, the panels of one case. Each panel takes the case (`d`) and `act` (run one API call, then reload the case) and shows what the
// viewer may do, with the reason in WORDS when a button is switched off. The rules themselves are in the database (migration 183); a panel only offers
// what src/lib/compliance/transitions.ts says can happen, and the server answers a code if the database refuses.
// ============================================================

import { AlertTriangle, CheckCircle2, ExternalLink, Eye, EyeOff, FileText, Loader2, Lock, Upload } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { l10n } from "@/lib/compliance/fields";
import { actionsFor, isDataEditable, type ActionKey, type ActionState } from "@/lib/compliance/transitions";
import { fileFieldsOf } from "@/lib/compliance/fields";
import { IDENTITY_METHODS, RECOMMENDATIONS, type L10n, type RequestDetail } from "@/lib/compliance/types";
import { cn } from "@/lib/utils";

import {
  addNote,
  clockAction,
  editRequest,
  fileUrl,
  lookupLinks,
  reveal as revealApi,
  setStanding,
  tickStep,
  transition,
  uploadFile,
  type ApiResult,
  type LinkChoice,
  type RevealResult,
  type TransitionBody,
} from "./api";
import { REVEAL_MS, answersFromForm, collapseViews, eventLine, fieldLabel, formatWhen, localInputToIso, revealExpired, revealSecondsLeft } from "./helpers";
import { FieldInput } from "./new-request";
import { Notice, Panel, Person, Row } from "./parts";

const SELECT = "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Run one call; true when it worked (the screen then reloads the case). */
export type Act = (fn: () => Promise<ApiResult<unknown>>) => Promise<boolean>;

export interface PanelProps {
  d: RequestDetail;
  act: Act;
  busy: boolean;
  now: number;
}

const find = (actions: ActionState[], key: ActionKey) => actions.find((a) => a.key === key);

/** The inputs for actionsFor, from the case. */
export function actionsOf(d: RequestDetail, overrideTyped = false): ActionState[] {
  return actionsFor({
    status: d.status,
    viewer: d.viewer,
    requiresIdentityCheck: d.type?.requiresIdentityCheck ?? true,
    checkDues: d.type?.checkDues ?? false,
    identity: { outcome: d.identityCheck.outcome ?? null, verifiedBy: d.identityCheck.verifiedBy ?? null, recordedBy: d.identityCheck.recordedBy ?? null },
    duesOutstanding: d.standing.duesOutstanding ?? null,
    hasOverride: overrideTyped,
    recommendation: d.review.recommendation ?? null,
    checklistTotal: d.checklist.length,
    checklistDone: d.checklist.filter((c) => c.done).length,
  });
}

/** Why an action is switched off, in words (or nothing when it is on or missing). */
function Why({ action }: { action: ActionState | undefined }) {
  const t = useTranslations("Compliance.blocked");
  if (!action || action.enabled || !action.reason) return null;
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground" data-reason={action.reason}>
      <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span>{t(action.reason)}</span>
    </p>
  );
}

function Busy({ busy }: { busy: boolean }) {
  return busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null;
}

// ------------------------------------------------------------
// Customer and answers
// ------------------------------------------------------------
export function CustomerPanel({ d, act, busy }: PanelProps) {
  const t = useTranslations("Compliance.customer");
  const tc = useTranslations("Compliance");
  const locale = useLocale();
  const canEdit = (d.viewer.canReview || d.viewer.canApprove) && isDataEditable(d.status);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(d.customerName);
  const [email, setEmail] = useState(d.customerEmail ?? "");
  const [phone, setPhone] = useState(d.customerPhone ?? "");
  const [channel, setChannel] = useState(d.channel ?? "");
  const [received, setReceived] = useState("");

  const save = async () => {
    const iso = localInputToIso(received);
    const ok = await act(() => editRequest(d.id, { customerName: name, customerEmail: email || null, customerPhone: phone || null, channel: channel || null, ...(iso ? { receivedAt: iso } : {}) }));
    if (ok) setEditing(false);
  };

  return (
    <Panel
      id="cmp-customer"
      title={t("title")}
      aside={
        canEdit && !editing ? (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            {t("edit")}
          </Button>
        ) : null
      }
    >
      {editing ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="cmp-e-name" className="mb-1 block text-sm font-medium">{t("name")}</label>
            <Input id="cmp-e-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          </div>
          <div>
            <label htmlFor="cmp-e-email" className="mb-1 block text-sm font-medium">{t("email")}</label>
            <Input id="cmp-e-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} />
          </div>
          <div>
            <label htmlFor="cmp-e-phone" className="mb-1 block text-sm font-medium">{t("phone")}</label>
            <Input id="cmp-e-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} />
          </div>
          <div>
            <label htmlFor="cmp-e-channel" className="mb-1 block text-sm font-medium">{t("channel")}</label>
            <Input id="cmp-e-channel" value={channel} onChange={(e) => setChannel(e.target.value)} maxLength={60} />
          </div>
          <div>
            <label htmlFor="cmp-e-received" className="mb-1 block text-sm font-medium">{t("received")}</label>
            <Input id="cmp-e-received" type="datetime-local" value={received} onChange={(e) => setReceived(e.target.value)} />
            <p className="mt-1 text-xs text-muted-foreground">{t("receivedEditHint")}</p>
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <Button onClick={save} disabled={busy || name.trim() === ""}>
              <Busy busy={busy} />
              {tc("save")}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              {tc("cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <dl>
          <Row label={t("name")}>{d.customerName}</Row>
          <Row label={t("email")}>{d.customerEmail ?? <span className="text-muted-foreground">{tc("none")}</span>}</Row>
          <Row label={t("phone")}>{d.customerPhone ?? <span className="text-muted-foreground">{tc("none")}</span>}</Row>
          <Row label={t("channel")}>{d.channel ?? <span className="text-muted-foreground">{tc("none")}</span>}</Row>
          <Row label={t("received")}>{formatWhen(d.receivedAt, locale)}</Row>
          <Row label={t("source")}>{t(`sources.${d.source}`)}</Row>
        </dl>
      )}
    </Panel>
  );
}

/** One non-sensitive answer as text. */
function answerText(f: RequestDetail["type"] extends infer T ? (T extends { fields: (infer F)[] } ? F : never) : never, v: unknown, locale: string, yes: string, no: string): string {
  if (f.type === "acknowledge" || f.type === "yesno") return v === true ? yes : v === false ? no : "";
  if (f.type === "choice") {
    const o = f.options?.find((x) => x.value === v);
    return o ? l10n(o.label as L10n, locale) : String(v ?? "");
  }
  if (v === null || v === undefined) return "";
  return String(v);
}

export function AnswersPanel({ d, act, busy }: PanelProps) {
  const t = useTranslations("Compliance.answers");
  const tc = useTranslations("Compliance");
  const locale = useLocale();
  const fields = useMemo(() => (d.type?.fields ?? []).filter((f) => !f.sensitive && f.type !== "file"), [d.type]);
  const canEdit = (d.viewer.canReview || d.viewer.canApprove) && isDataEditable(d.status) && fields.length > 0;
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string | boolean>>({});

  const startEdit = () => {
    const v: Record<string, string | boolean> = {};
    for (const f of fields) {
      const cur = d.data[f.key];
      v[f.key] = f.type === "acknowledge" ? cur === true : cur === undefined || cur === null ? "" : String(cur);
    }
    setValues(v);
    setEditing(true);
  };
  const save = async () => {
    const ok = await act(() => editRequest(d.id, { answers: answersFromForm(fields, values) }));
    if (ok) setEditing(false);
  };

  return (
    <Panel
      id="cmp-answers"
      title={t("title")}
      aside={
        canEdit && !editing ? (
          <Button variant="ghost" size="sm" onClick={startEdit}>
            {t("edit")}
          </Button>
        ) : null
      }
    >
      {fields.length === 0 ? <p className="text-sm text-muted-foreground">{t("none")}</p> : null}
      {editing ? (
        <div className="space-y-3">
          {fields.map((f) => (
            <FieldInput key={f.key} idPrefix="cmp-a" field={f} value={values[f.key] ?? ""} onChange={(v) => setValues({ ...values, [f.key]: v })} />
          ))}
          <div className="flex gap-2">
            <Button onClick={save} disabled={busy}>
              <Busy busy={busy} />
              {tc("save")}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              {tc("cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <dl>
          {fields.map((f) => {
            const text = answerText(f, d.data[f.key], locale, tc("yes"), tc("no"));
            return (
              <Row key={f.key} label={fieldLabel(f, locale)}>
                {text !== "" ? text : <span className="text-muted-foreground">{tc("none")}</span>}
              </Row>
            );
          })}
        </dl>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------
// Bank & sensitive details: masked until revealed
// ------------------------------------------------------------
export function SensitivePanel({ d, now, revealed, onRevealed, onHide }: PanelProps & { revealed: { result: RevealResult; until: number } | null; onRevealed: (r: RevealResult) => void; onHide: () => void }) {
  const t = useTranslations("Compliance.sensitive");
  const tErr = useTranslations("Compliance.errors");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (d.sensitive.length === 0) return null;

  const showing = revealed && !revealExpired(revealed.until, now) ? revealed : null;
  const values = new Map(showing?.result.fields.map((f) => [f.key, f.value]) ?? []);

  const doReveal = async () => {
    setBusy(true);
    setError(null);
    const res = await revealApi(d.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.code);
      return;
    }
    onRevealed(res.data);
  };

  return (
    <Panel
      id="cmp-sensitive"
      title={t("title")}
      aside={
        showing ? (
          <Button variant="outline" size="sm" onClick={onHide}>
            <EyeOff className="size-3.5" aria-hidden />
            {t("hide")}
          </Button>
        ) : d.viewer.canReveal ? (
          <Button variant="outline" size="sm" onClick={doReveal} disabled={busy || !d.sensitiveReadable}>
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
            {t("reveal")}
          </Button>
        ) : null
      }
    >
      {!d.sensitiveReadable ? <Notice tone="danger" icon={<AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}>{t("unreadable")}</Notice> : null}
      <dl>
        {d.sensitive.map((s) => (
          <Row key={s.key} label={l10n(s.label, locale, s.key)}>
            {showing ? (
              <span className="font-mono text-sm" data-revealed="true">{values.get(s.key) ?? ""}</span>
            ) : s.present ? (
              <span className="inline-flex items-center gap-1 font-mono text-sm" data-masked="true">
                <Lock className="size-3 text-muted-foreground" aria-hidden />
                {s.masked}
              </span>
            ) : (
              <span className="text-muted-foreground">{t("notGiven")}</span>
            )}
          </Row>
        ))}
      </dl>
      {showing ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {t("hidesIn", { seconds: revealSecondsLeft(showing.until, now) })}
        </p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">{d.viewer.canReveal ? t("revealHint") : t("noReveal")}</p>
      )}
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{tErr(error)}</p> : null}
    </Panel>
  );
}

export { REVEAL_MS };

// ------------------------------------------------------------
// Account standing (a closure's outstanding dues)
// ------------------------------------------------------------
export function StandingPanel({ d, act, busy }: PanelProps) {
  const t = useTranslations("Compliance.standing");
  const tc = useTranslations("Compliance");
  const locale = useLocale();
  const [dues, setDues] = useState<boolean | null>(d.standing.duesOutstanding ?? null);
  const [notes, setNotes] = useState(d.standing.notes ?? "");
  if (!d.type?.checkDues) return null;
  const canEdit = (d.viewer.canReview || d.viewer.canApprove) && ["received", "identity_check", "officer_review"].includes(d.status);

  return (
    <Panel id="cmp-standing" title={t("title")}>
      <p className="mb-2 text-sm text-muted-foreground">{t("intro")}</p>
      {d.standing.duesOutstanding === true ? <Notice tone="warn" icon={<AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}>{t("blocksApproval")}</Notice> : null}
      {canEdit ? (
        <fieldset className="mt-2 space-y-2">
          <legend className="sr-only">{t("question")}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="cmp-dues" checked={dues === false} onChange={() => setDues(false)} className="size-4 accent-[var(--primary)]" />
            {t("noDues")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="cmp-dues" checked={dues === true} onChange={() => setDues(true)} className="size-4 accent-[var(--primary)]" />
            {t("dues")}
          </label>
          <div>
            <label htmlFor="cmp-dues-notes" className="mb-1 block text-sm font-medium">{t("notes")}</label>
            <Textarea id="cmp-dues-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={2} />
          </div>
          <Button onClick={() => dues !== null && void act(() => setStanding(d.id, dues, notes))} disabled={busy || dues === null}>
            <Busy busy={busy} />
            {t("save")}
          </Button>
        </fieldset>
      ) : (
        <dl>
          <Row label={t("question")}>
            {d.standing.duesOutstanding === null || d.standing.duesOutstanding === undefined ? <span className="text-muted-foreground">{t("notRecorded")}</span> : d.standing.duesOutstanding ? t("dues") : t("noDues")}
          </Row>
          {d.standing.notes ? <Row label={t("notes")}>{d.standing.notes}</Row> : null}
          {d.standing.setBy ? <Row label={t("recordedBy")}>{d.standing.source === "api" ? t("sourceApi") : t("sourceManual")} · {formatWhen(d.standing.setAt, locale)}</Row> : null}
        </dl>
      )}
      <p className="mt-2 text-xs text-muted-foreground">{tc("notConnected", { what: t("backOffice") })}</p>
    </Panel>
  );
}

// ------------------------------------------------------------
// Identity check
// ------------------------------------------------------------
export function IdentityPanel({ d, act, busy }: PanelProps) {
  const t = useTranslations("Compliance.identity");
  const tc = useTranslations("Compliance");
  const locale = useLocale();
  const actions = actionsOf(d);
  const record = find(actions, "record_identity_check");
  const start = find(actions, "start_identity_check");
  const back = find(actions, "send_back_to_identity_check");
  const [method, setMethod] = useState<string>("");
  const [other, setOther] = useState("");
  const [outcome, setOutcome] = useState<"pass" | "fail" | "">("");
  const [notes, setNotes] = useState("");
  const [backNote, setBackNote] = useState("");
  const required = d.type?.requiresIdentityCheck ?? true;
  const ic = d.identityCheck;
  const recorded = !!ic.outcome;

  const ready = !required || (method !== "" && (method !== "other" || other.trim() !== "") && outcome !== "" && (outcome !== "fail" || notes.trim() !== ""));
  const submit = () => {
    const body: TransitionBody = { to: "officer_review", note: notes };
    if (required) body.identity = { method, methodOther: other, outcome };
    void act(() => transition(d.id, body));
  };

  return (
    <Panel id="cmp-identity" title={t("title")}>
      {recorded ? (
        <dl>
          {ic.outcome === "not_required" ? (
            <Row label={t("outcome")}>{t("notRequired")}</Row>
          ) : (
            <>
              <Row label={t("method")}>{ic.method ? (ic.method === "other" ? `${t("methods.other")}: ${ic.methodOther ?? ""}` : t(`methods.${ic.method}`)) : ""}</Row>
              <Row label={t("outcome")}>
                <span className="inline-flex items-center gap-1 font-medium">
                  {ic.outcome === "pass" ? <CheckCircle2 className="size-4 text-[light-dark(#047857,#6ee7b7)]" aria-hidden /> : <AlertTriangle className="size-4 text-destructive" aria-hidden />}
                  {t(`outcomes.${ic.outcome}`)}
                </span>
              </Row>
              <Row label={t("verifiedBy")}>
                <Person person={ic.verifiedBy ? { id: ic.verifiedBy, name: d.events.find((e) => e.kind === "identity_check")?.actor?.name ?? null } : null} /> · {formatWhen(ic.verifiedAt, locale)}
              </Row>
              {ic.notes ? <Row label={t("notes")}>{ic.notes}</Row> : null}
            </>
          )}
        </dl>
      ) : null}

      {(d.status === "received" || d.status === "identity_check") && record ? (
        record.enabled ? (
          <div className="space-y-3">
            {required ? (
              <>
                <p className="text-sm text-muted-foreground">{t("intro")}</p>
                <div>
                  <label htmlFor="cmp-id-method" className="mb-1 block text-sm font-medium">{t("method")}</label>
                  <select id="cmp-id-method" className={SELECT} value={method} onChange={(e) => setMethod(e.target.value)}>
                    <option value="">{tc("form.choose")}</option>
                    {IDENTITY_METHODS.map((m) => (
                      <option key={m} value={m}>{t(`methods.${m}`)}</option>
                    ))}
                  </select>
                </div>
                {method === "other" ? (
                  <div>
                    <label htmlFor="cmp-id-other" className="mb-1 block text-sm font-medium">{t("methodOther")}</label>
                    <Input id="cmp-id-other" value={other} onChange={(e) => setOther(e.target.value)} maxLength={200} />
                  </div>
                ) : null}
                <fieldset className="space-y-1.5">
                  <legend className="mb-1 text-sm font-medium">{t("outcome")}</legend>
                  {(["pass", "fail"] as const).map((o) => (
                    <label key={o} className="flex items-center gap-2 text-sm">
                      <input type="radio" name="cmp-id-outcome" checked={outcome === o} onChange={() => setOutcome(o)} className="size-4 accent-[var(--primary)]" />
                      {t(`outcomes.${o}`)}
                    </label>
                  ))}
                </fieldset>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t("notNeeded")}</p>
            )}
            <div>
              <label htmlFor="cmp-id-notes" className="mb-1 block text-sm font-medium">{t("notes")}{outcome === "fail" ? <span className="text-destructive"> *</span> : null}</label>
              <Textarea id="cmp-id-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={3} />
            </div>
            <p className="text-xs text-muted-foreground">{t("byYou")}</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={submit} disabled={busy || !ready}>
                <Busy busy={busy} />
                {required ? t("record") : t("continue")}
              </Button>
              {start?.enabled && d.status === "received" ? (
                <Button variant="outline" onClick={() => void act(() => transition(d.id, { to: "identity_check" }))} disabled={busy}>
                  {t("start")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <Why action={record} />
        )
      ) : null}

      {d.status === "officer_review" && back?.enabled ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <label htmlFor="cmp-id-back" className="block text-sm font-medium">{t("sendBackNote")}</label>
          <Textarea id="cmp-id-back" value={backNote} onChange={(e) => setBackNote(e.target.value)} maxLength={2000} rows={2} />
          <Button variant="outline" onClick={() => void act(() => transition(d.id, { to: "identity_check", note: backNote }))} disabled={busy || backNote.trim() === ""}>
            {t("sendBack")}
          </Button>
        </div>
      ) : null}

      {!recorded && d.status !== "received" && d.status !== "identity_check" ? <p className="text-sm text-muted-foreground">{t("none")}</p> : null}
    </Panel>
  );
}

// ------------------------------------------------------------
// Officer review
// ------------------------------------------------------------
export function ReviewPanel({ d, act, busy }: PanelProps) {
  const t = useTranslations("Compliance.review");
  const locale = useLocale();
  const submitAction = find(actionsOf(d), "submit_review");
  const [rec, setRec] = useState<string>("");
  const [notes, setNotes] = useState("");
  const r = d.review;
  const needsNote = rec === "reject" || rec === "more_info";

  return (
    <Panel id="cmp-review" title={t("title")}>
      {r.recommendation ? (
        <dl>
          <Row label={t("recommendation")}>{t(`recommendations.${r.recommendation}`)}</Row>
          {r.notes ? <Row label={t("notes")}>{r.notes}</Row> : null}
          <Row label={t("by")}>
            <Person person={r.by ? { id: r.by, name: d.events.find((e) => e.kind === "review")?.actor?.name ?? null } : null} /> · {formatWhen(r.at, locale)}
          </Row>
          {r.sentBackNote ? <Row label={t("sentBack")}>{r.sentBackNote}</Row> : null}
        </dl>
      ) : null}
      {d.status === "officer_review" && submitAction ? (
        submitAction.enabled ? (
          <div className={cn("space-y-3", r.recommendation && "mt-3 border-t border-border pt-3")}>
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-sm font-medium">{t("recommendation")}</legend>
              {RECOMMENDATIONS.map((x) => (
                <label key={x} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="cmp-rec" checked={rec === x} onChange={() => setRec(x)} className="size-4 accent-[var(--primary)]" />
                  {t(`recommendations.${x}`)}
                </label>
              ))}
            </fieldset>
            <div>
              <label htmlFor="cmp-rec-notes" className="mb-1 block text-sm font-medium">{t("notes")}{needsNote ? <span className="text-destructive"> *</span> : null}</label>
              <Textarea id="cmp-rec-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={3} />
            </div>
            <Button onClick={() => void act(() => transition(d.id, { to: "awaiting_signoff", recommendation: rec, note: notes }))} disabled={busy || rec === "" || (needsNote && notes.trim() === "")}>
              <Busy busy={busy} />
              {t("submit")}
            </Button>
          </div>
        ) : (
          <Why action={submitAction} />
        )
      ) : null}
      {!r.recommendation && d.status !== "officer_review" ? <p className="text-sm text-muted-foreground">{t("notYet")}</p> : null}
    </Panel>
  );
}

// ------------------------------------------------------------
// Head of Compliance sign-off
// ------------------------------------------------------------
export function SignoffPanel({ d, act, busy }: PanelProps) {
  const t = useTranslations("Compliance.signoff");
  const locale = useLocale();
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState("");
  const actions = actionsOf(d, override.trim() !== "");
  const approve = find(actions, "approve");
  const reject = find(actions, "reject");
  const back = find(actions, "send_back_to_officer");
  const s = d.signoff;
  const needsOverride = !!d.type?.checkDues && d.standing.duesOutstanding === true;
  const name = d.events.find((e) => e.kind === "signoff")?.actor?.name ?? null;

  return (
    <Panel id="cmp-signoff" title={t("title")}>
      {s.decision ? (
        <dl>
          <Row label={t("decision")}>
            <span className="inline-flex items-center gap-1 font-medium">
              {s.decision === "approved" ? <CheckCircle2 className="size-4 text-[light-dark(#047857,#6ee7b7)]" aria-hidden /> : <AlertTriangle className="size-4 text-destructive" aria-hidden />}
              {t(`decisions.${s.decision}`)}
            </span>
          </Row>
          <Row label={t("by")}>
            <Person person={s.by ? { id: s.by, name } : null} /> · {formatWhen(s.at, locale)}
          </Row>
          {s.reason ? <Row label={t("reason")}>{s.reason}</Row> : null}
          {s.overrideReason ? <Row label={t("override")}>{s.overrideReason}</Row> : null}
        </dl>
      ) : null}

      {d.status === "awaiting_signoff" ? (
        <div className="space-y-3">
          {!d.viewer.canApprove ? <Notice>{t("onlyHead")}</Notice> : null}
          {needsOverride ? (
            <div>
              <label htmlFor="cmp-override" className="mb-1 block text-sm font-medium">{t("overrideLabel")}</label>
              <Textarea id="cmp-override" value={override} onChange={(e) => setOverride(e.target.value)} maxLength={2000} rows={2} />
              <p className="mt-1 text-xs text-muted-foreground">{t("overrideHint")}</p>
            </div>
          ) : null}
          <div>
            <label htmlFor="cmp-signoff-reason" className="mb-1 block text-sm font-medium">{t("reasonLabel")}</label>
            <Textarea id="cmp-signoff-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} rows={3} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void act(() => transition(d.id, { to: "approved", note: reason, ...(override.trim() ? { overrideReason: override } : {}) }))} disabled={busy || !approve?.enabled} aria-describedby="cmp-signoff-why">
              <Busy busy={busy} />
              {t("approve")}
            </Button>
            <Button variant="destructive" onClick={() => void act(() => transition(d.id, { to: "rejected", note: reason }))} disabled={busy || !reject?.enabled || reason.trim() === ""}>
              {t("reject")}
            </Button>
            <Button variant="outline" onClick={() => void act(() => transition(d.id, { to: "officer_review", note: reason }))} disabled={busy || !back?.enabled || reason.trim() === ""}>
              {t("sendBack")}
            </Button>
          </div>
          <div id="cmp-signoff-why">
            <Why action={approve} />
            {approve?.enabled && reason.trim() === "" ? <p className="mt-1 text-xs text-muted-foreground">{t("reasonNeeded")}</p> : null}
          </div>
        </div>
      ) : !s.decision ? (
        <p className="text-sm text-muted-foreground">{t("notYet")}</p>
      ) : null}
    </Panel>
  );
}

// ------------------------------------------------------------
// Execution checklist and the close
// ------------------------------------------------------------
export function ExecutionPanel({ d, act, busy }: PanelProps) {
  const t = useTranslations("Compliance.execution");
  const locale = useLocale();
  const actions = actionsOf(d);
  const mark = find(actions, "mark_executing");
  const complete = find(actions, "complete");
  const close = find(actions, "close");
  const [closeNote, setCloseNote] = useState("");
  const canTick = d.viewer.canExecute && (d.status === "approved" || d.status === "executing");
  const open = d.status === "approved" || d.status === "executing" || d.status === "completed" || d.status === "closed";

  if (d.checklist.length === 0 && !open && d.status !== "rejected") return null;

  return (
    <Panel id="cmp-execution" title={t("title")}>
      {d.status !== "approved" && d.status !== "executing" && d.status !== "completed" && d.status !== "closed" && d.status !== "rejected" ? <p className="text-sm text-muted-foreground">{t("notYet")}</p> : null}
      {d.checklist.length > 0 ? (
        <ul className="space-y-2">
          {d.checklist.map((c) => (
            <li key={c.stepKey} className="flex items-start gap-2">
              <input
                id={`cmp-step-${c.stepKey}`}
                type="checkbox"
                checked={c.done}
                disabled={!canTick || busy}
                onChange={(e) => void act(() => tickStep(d.id, c.stepKey, e.target.checked))}
                className="mt-1 size-4 shrink-0 accent-[var(--primary)]"
              />
              <label htmlFor={`cmp-step-${c.stepKey}`} className="min-w-0 text-sm">
                <span className={cn(c.done && "text-muted-foreground line-through")}>{l10n(c.labelL10n as L10n, locale, c.label)}</span>
                {c.done ? (
                  <span className="block text-xs text-muted-foreground">
                    {t("doneBy")} <Person person={c.doneBy} /> · {formatWhen(c.doneAt, locale)}
                    {c.note ? ` · ${c.note}` : ""}
                  </span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      ) : open ? (
        <p className="text-sm text-muted-foreground">{t("noSteps")}</p>
      ) : null}
      {(d.status === "approved" || d.status === "executing") && !d.viewer.canExecute ? <p className="mt-2 text-xs text-muted-foreground">{t("onlyOperations")}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {mark?.enabled ? (
          <Button variant="outline" onClick={() => void act(() => transition(d.id, { to: "executing" }))} disabled={busy}>
            {t("markExecuting")}
          </Button>
        ) : null}
        {complete ? (
          <Button onClick={() => void act(() => transition(d.id, { to: "completed" }))} disabled={busy || !complete.enabled}>
            <Busy busy={busy} />
            {t("complete")}
          </Button>
        ) : null}
      </div>
      <Why action={complete} />
      {close ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <label htmlFor="cmp-close-note" className="block text-sm font-medium">{d.status === "rejected" ? t("closeRejected") : t("closeCompleted")}</label>
          <Textarea id="cmp-close-note" value={closeNote} onChange={(e) => setCloseNote(e.target.value)} maxLength={2000} rows={2} placeholder={t("closeNotePlaceholder")} />
          <Button onClick={() => void act(() => transition(d.id, { to: "closed", note: closeNote }))} disabled={busy || !close.enabled}>
            {t("close")}
          </Button>
          <Why action={close} />
        </div>
      ) : null}
    </Panel>
  );
}

/** "Close without a decision" (a duplicate, or the customer withdrew): before the sign-off only. */
export function CloseWithoutDecision({ d, act, busy }: PanelProps) {
  const t = useTranslations("Compliance.execution");
  const a = find(actionsOf(d), "close_without_decision");
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (!a?.enabled) return null;
  return (
    <div className="rounded-xl border border-dashed border-border p-3">
      {open ? (
        <div className="space-y-2">
          <label htmlFor="cmp-cwd" className="block text-sm font-medium">{t("withdrawnReason")}</label>
          <Textarea id="cmp-cwd" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} />
          <div className="flex gap-2">
            <Button variant="destructive" onClick={() => void act(() => transition(d.id, { to: "closed", note }))} disabled={busy || note.trim() === ""}>
              {t("closeWithoutDecision")}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t("keepOpen")}</Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>{t("closeWithoutDecision")}</Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// The clock: the Head's pause
// ------------------------------------------------------------
export function ClockPanel({ d, act, busy }: PanelProps) {
  const t = useTranslations("Compliance.clockPanel");
  const [note, setNote] = useState("");
  if (!d.type?.allowPause || !d.viewer.canApprove || (!d.hardStopAt && !d.targetDueAt) || d.status === "completed" || d.status === "closed") return null;
  const paused = d.pausedAt !== null;
  return (
    <Panel id="cmp-clock" title={t("title")}>
      <p className="mb-2 text-sm text-muted-foreground">{paused ? t("pausedBody") : t("body")}</p>
      <label htmlFor="cmp-clock-note" className="mb-1 block text-sm font-medium">{t("note")}</label>
      <Textarea id="cmp-clock-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} />
      <Button className="mt-2" variant={paused ? "default" : "outline"} onClick={async () => { if (await act(() => clockAction(d.id, paused ? "resume" : "pause", note))) setNote(""); }} disabled={busy || note.trim() === ""}>
        <Busy busy={busy} />
        {paused ? t("resume") : t("pause")}
      </Button>
    </Panel>
  );
}

// ------------------------------------------------------------
// Files
// ------------------------------------------------------------
export function FilesPanel({ d, act, busy }: PanelProps) {
  const t = useTranslations("Compliance.files");
  const tErr = useTranslations("Compliance.errors");
  const locale = useLocale();
  const canUpload = (d.viewer.canReview || d.viewer.canApprove) && d.status !== "closed";
  const canOpen = d.viewer.canReview || d.viewer.canApprove || d.viewer.canReveal;
  const expected = fileFieldsOf(d.type?.fields ?? []);
  const input = useRef<HTMLInputElement | null>(null);
  const [field, setField] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const choose = (f?: string) => {
    setField(f);
    input.current?.click();
  };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const res = await uploadFile(d.id, file, field);
    if (!res.ok) {
      setError(res.code);
      return;
    }
    await act(async () => ({ ok: true, data: null }));
  };

  return (
    <Panel
      id="cmp-files"
      title={t("title")}
      aside={
        canUpload ? (
          <Button variant="outline" size="sm" onClick={() => choose(undefined)} disabled={busy}>
            <Upload className="size-3.5" aria-hidden />
            {t("add")}
          </Button>
        ) : null
      }
    >
      <input ref={input} type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
      {expected.length > 0 ? (
        <ul className="mb-3 space-y-1 text-sm text-muted-foreground">
          {expected.map((f) => {
            const have = d.files.filter((x) => x.fieldKey === f.key).length;
            return (
              <li key={f.key} className="flex flex-wrap items-center gap-2">
                <span>{fieldLabel(f, locale)}</span>
                <span className="text-xs">{have > 0 ? t("haveCount", { count: have }) : t("missing")}</span>
                {canUpload ? (
                  <Button variant="ghost" size="xs" onClick={() => choose(f.key)} disabled={busy}>
                    {t("attach")}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {d.files.length === 0 ? <p className="text-sm text-muted-foreground">{t("none")}</p> : null}
      <ul className="space-y-2">
        {d.files.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-2 text-sm">
            <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {canOpen ? (
              <a href={fileUrl(d.id, f.id)} download className="min-w-0 break-all text-primary underline-offset-2 hover:underline">{f.name}</a>
            ) : (
              <span className="min-w-0 break-all">{f.name}</span>
            )}
            <span className="text-xs text-muted-foreground">
              {Math.max(1, Math.round(f.size / 1024))} KB · <Person person={f.uploadedBy} /> · {formatWhen(f.uploadedAt, locale)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">{t("rules")}</p>
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{tErr(error)}</p> : null}
    </Panel>
  );
}

// ------------------------------------------------------------
// Links
// ------------------------------------------------------------
export function LinksPanel({ d, act, busy }: PanelProps) {
  const t = useTranslations("Compliance.links");
  const tc = useTranslations("Compliance");
  const canEdit = (d.viewer.canReview || d.viewer.canApprove) && d.status !== "closed";
  const [kind, setKind] = useState<LinkChoice["kind"]>("ticket");
  const [q, setQ] = useState("");
  const [choices, setChoices] = useState<LinkChoice[] | null>(null);
  const [kyc, setKyc] = useState(d.links.kycValidationRef ?? "");
  const l = d.links;

  const search = async () => {
    const res = await lookupLinks(kind, q);
    setChoices(res.ok ? res.data.choices : []);
  };
  const pick = async (c: LinkChoice) => {
    const key = c.kind === "contact" ? "contactId" : c.kind === "ticket" ? "ticketId" : "incidentId";
    if (await act(() => editRequest(d.id, { [key]: c.id }))) {
      setChoices(null);
      setQ("");
    }
  };
  const unlink = (key: string) => void act(() => editRequest(d.id, { [key]: null }));

  const item = (label: string, text: ReactNode, href: string | null, key: string | null) => (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-24 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{text}</span>
      {href ? (
        <Link href={href} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          <ExternalLink className="size-3" aria-hidden />
          {t("open")}
        </Link>
      ) : null}
      {key && canEdit ? (
        <Button variant="ghost" size="xs" onClick={() => unlink(key)} disabled={busy}>
          {t("unlink")}
        </Button>
      ) : null}
    </li>
  );

  return (
    <Panel id="cmp-links" title={t("title")}>
      <ul className="space-y-1.5">
        {l.contact ? item(t("contact"), l.contact.name ?? l.contact.id, `/contacts?contact=${l.contact.id}`, "contactId") : null}
        {l.conversationId ? item(t("conversation"), t("conversationText"), `/inbox?c=${l.conversationId}`, "conversationId") : null}
        {l.ticket ? item(t("ticket"), `#${l.ticket.number ?? ""} ${l.ticket.subject ?? ""}`.trim(), `/tickets/${l.ticket.id}`, "ticketId") : null}
        {l.incident ? item(t("incident"), `#${l.incident.number ?? ""} ${l.incident.title ?? ""}`.trim(), `/incidents/${l.incident.id}`, "incidentId") : null}
        {l.kycValidationRef ? item(t("kyc"), <code className="rounded bg-muted px-1 text-xs">{l.kycValidationRef}</code>, "/kyc", canEdit ? "kycValidationRef" : null) : null}
      </ul>
      {!l.contact && !l.conversationId && !l.ticket && !l.incident && !l.kycValidationRef ? <p className="text-sm text-muted-foreground">{t("none")}</p> : null}
      {canEdit ? (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="cmp-link-kind" className="mb-1 block text-xs font-medium">{t("addLabel")}</label>
              <select id="cmp-link-kind" className={cn(SELECT, "w-32")} value={kind} onChange={(e) => { setKind(e.target.value as LinkChoice["kind"]); setChoices(null); }}>
                <option value="ticket">{t("ticket")}</option>
                <option value="incident">{t("incident")}</option>
                <option value="contact">{t("contact")}</option>
              </select>
            </div>
            <div className="min-w-0 flex-1 basis-40">
              <label htmlFor="cmp-link-q" className="sr-only">{t("search")}</label>
              <Input id="cmp-link-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchPlaceholder")} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} maxLength={100} />
            </div>
            <Button variant="outline" onClick={search} disabled={busy || q.trim() === ""}>{t("find")}</Button>
          </div>
          {choices ? (
            choices.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noMatches")}</p>
            ) : (
              <ul className="space-y-1">
                {choices.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => void pick(c)} className="w-full rounded-lg border border-border px-2 py-1.5 text-left text-sm hover:bg-muted">{c.label}</button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-40">
              <label htmlFor="cmp-link-kyc" className="mb-1 block text-xs font-medium">{t("kycLabel")}</label>
              <Input id="cmp-link-kyc" value={kyc} onChange={(e) => setKyc(e.target.value)} maxLength={200} autoComplete="off" spellCheck={false} />
            </div>
            <Button variant="outline" onClick={() => void act(() => editRequest(d.id, { kycValidationRef: kyc.trim() || null }))} disabled={busy || kyc.trim() === (l.kycValidationRef ?? "")}>{tc("save")}</Button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

// ------------------------------------------------------------
// Timeline and notes
// ------------------------------------------------------------
export function TimelinePanel({ d, act, busy }: PanelProps) {
  const t = useTranslations("Compliance.timeline");
  const tc = useTranslations("Compliance");
  const locale = useLocale();
  const canNote = d.viewer.canReview || d.viewer.canApprove;
  const [note, setNote] = useState("");
  const word = (group: string, v: string): string => {
    try {
      return v ? tc(`${group}.${v}`) : "";
    } catch {
      return v;
    }
  };

  return (
    <Panel id="cmp-timeline" title={t("title")}>
      {canNote ? (
        <div className="mb-3 space-y-2">
          <label htmlFor="cmp-note" className="block text-sm font-medium">{t("addNote")}</label>
          <Textarea id="cmp-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} />
          <Button variant="outline" size="sm" onClick={async () => { if (await act(() => addNote(d.id, note))) setNote(""); }} disabled={busy || note.trim() === ""}>
            {t("saveNote")}
          </Button>
        </div>
      ) : null}
      <ol className="space-y-3">
        {collapseViews(d.events).map((e) => {
          const line = eventLine(e);
          if (line.key === "view" && e.count > 1) line.key = "view_many";
          const extra = { count: e.count };
          const values: Record<string, string | number> = { ...line.values };
          if (line.key === "status") {
            values.from = word("status", String(values.from));
            values.to = word("status", String(values.to));
          }
          if (line.key === "identity_check") {
            values.method = word("identity.methods", String(values.method));
            values.outcome = word("identity.outcomes", String(values.outcome));
          }
          if (line.key === "review") values.recommendation = word("review.recommendations", String(values.recommendation));
          if (line.key === "signoff" || line.key === "signoff_override") values.decision = word("signoff.decisions", String(values.decision));
          if (line.key === "created" || line.key === "created_backdated") values.source = word("customer.sources", String(values.source));
          return (
            <li key={e.id} className="border-l-2 border-border pl-3" data-kind={e.kind}>
              <p className="text-sm text-foreground">
                {t(`kinds.${line.key}`, { ...values, ...extra })}
              </p>
              {line.text ? <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-muted-foreground">{line.text}</p> : null}
              <p className="mt-0.5 text-xs text-muted-foreground">
                <Person person={e.actor} fallback={t("system")} /> · {formatWhen(e.at, locale)}
              </p>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

// a small hook for the reveal timer, kept here so the screen only wires it
export function useRevealTimer(now: number, revealed: { until: number } | null, hide: () => void) {
  useEffect(() => {
    if (revealed && revealExpired(revealed.until, now)) hide();
  }, [now, revealed, hide]);
}
