"use client";

// ============================================================
// Compliance requests, raising from the Inbox and from tickets (Part B): the button in a conversation's header and in a ticket's, the dialog behind it, and
// what the person who raised sees afterwards: a status chip ("CMP-2026-000014 · In review") and a short list of what THEY raised.
//
// The person needs `compliance.raise`; they do not need the Compliance menu. They see the reference, the type and the status of their own requests and
// nothing else about a case: no customer, no answer, no bank detail, no reason. A link to the case appears only for a person who also holds the
// Compliance menu. The conversation or ticket is read with the person's own session on the server, so the button works only where they could open it.
// ============================================================

import { ClipboardSignature, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { TONE } from "@/components/comments/chips";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCapability } from "@/hooks/use-auth";
import type { RaiseContext, RaisedItem } from "@/lib/compliance/raise-types";
import type { FieldDef } from "@/lib/compliance/types";
import { cn } from "@/lib/utils";

import { getRaiseContext, getRaised, raiseRequest, type RaiseTarget } from "./api";
import { answersFromForm, emptyForm, errorKey, localInputToIso, missingRequired, type FormValues } from "./helpers";
import { FieldInput } from "./new-request";
import { Notice } from "./parts";

const SELECT = "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const TONE_OF: Record<RaisedItem["status"], string> = {
  received: TONE.muted,
  in_review: TONE.primary,
  in_progress: TONE.warn,
  done: TONE.ok,
  not_approved: TONE.danger,
  closed: TONE.muted,
};

export const targetOf = (conversationId?: string | null, ticketId?: string | null): RaiseTarget | null => (conversationId ? { conversationId } : ticketId ? { ticketId } : null);

// ---- the button, the chips and the dialog -----------------------------------------------------------------------------------------

export function RaiseCompliance({ conversationId, ticketId, className }: { conversationId?: string | null; ticketId?: string | null; className?: string }) {
  const t = useTranslations("Compliance.raise");
  const can = useCapability("compliance.raise");
  const canOpen = useCapability("menu.compliance");
  const target = useMemo(() => targetOf(conversationId, ticketId), [conversationId, ticketId]);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<RaisedItem[]>([]);
  const key = conversationId ?? ticketId ?? "";

  const refresh = useCallback(async () => {
    if (!target) return;
    const res = await getRaised(target);
    if (res.ok) setItems(res.data.items);
  }, [target]);

  useEffect(() => {
    if (!can || !target) return;
    // load-on-change fetch whose result sets state
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [can, target, key, refresh]);

  if (!can || !target) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <RaisedChips items={items} canOpen={canOpen} />
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("button")}
        aria-label={t("button")}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ClipboardSignature className="size-4" aria-hidden />
        <span className="hidden sm:inline">{t("button")}</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("intro")}</DialogDescription>
          </DialogHeader>
          {open ? (
            <RaiseDialogBody
              target={target}
              canOpen={canOpen}
              onRaised={() => void refresh()}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The status chips of what this person raised on this conversation or ticket. */
export function RaisedChips({ items, canOpen }: { items: RaisedItem[]; canOpen: boolean }) {
  const t = useTranslations("Compliance.raise");
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-1" aria-label={t("mine.title")}>
      {items.slice(0, 3).map((i) => {
        const status = t(`status.${i.status}`);
        const chip = (
          <span className={cn("inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-medium", TONE_OF[i.status])} title={t("chip.title", { reference: i.reference, status })} data-status={i.status}>
            <span className="font-mono">{i.reference}</span>
            <span aria-hidden>·</span>
            <span>{status}</span>
          </span>
        );
        return <li key={i.reference}>{canOpen && i.id ? <Link href={`/compliance/${i.id}`}>{chip}</Link> : chip}</li>;
      })}
    </ul>
  );
}

/** "My raised requests": reference, type and status of what this person raised, newest first. */
export function RaisedList({ items, canOpen }: { items: RaisedItem[]; canOpen: boolean }) {
  const t = useTranslations("Compliance.raise");
  const locale = useLocale();
  return (
    <section aria-labelledby="cmp-mine-title" className="space-y-1.5">
      <h3 id="cmp-mine-title" className="text-sm font-semibold text-foreground">{t("mine.title")}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("mine.empty")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((i) => {
            const type = (i.typeLabelL10n as Record<string, string | undefined>)[locale] || i.typeLabel;
            return (
              <li key={i.reference} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                {canOpen && i.id ? (
                  <Link href={`/compliance/${i.id}`} className="font-mono font-medium text-primary hover:underline">{i.reference}</Link>
                ) : (
                  <span className="font-mono font-medium">{i.reference}</span>
                )}
                <span className="text-muted-foreground">{type}</span>
                <span className={cn("ml-auto inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium", TONE_OF[i.status])}>{t(`status.${i.status}`)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---- the dialog ---------------------------------------------------------------------------------------------------------------

function RaiseDialogBody({ target, canOpen, onRaised, onClose }: { target: RaiseTarget; canOpen: boolean; onRaised: () => void; onClose: () => void }) {
  const t = useTranslations("Compliance.raise");
  const tErr = useTranslations("Compliance.errors");
  const [ctx, setCtx] = useState<RaiseContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ reference: string; id?: string } | null>(null);
  const [mine, setMine] = useState<RaisedItem[]>([]);

  useEffect(() => {
    let live = true;
    void getRaiseContext(target).then((r) => {
      if (!live) return;
      if (r.ok) setCtx(r.data);
      else setError(errorKey(r.code));
    });
    void getRaised().then((r) => live && r.ok && setMine(r.data.items));
    return () => {
      live = false;
    };
  }, [target]);

  if (done) {
    return (
      <div className="space-y-3">
        <Notice>
          {t("done.title", { reference: done.reference })}
        </Notice>
        <p className="text-sm text-muted-foreground">{t("done.body")}</p>
        <div className="flex flex-wrap gap-2">
          {canOpen && done.id ? (
            <Link href={`/compliance/${done.id}`} className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted">
              {t("done.open")}
            </Link>
          ) : null}
          <Button variant="outline" size="sm" onClick={onClose}>{t("done.close")}</Button>
        </div>
      </div>
    );
  }
  if (error && !ctx) return <Notice tone="danger">{tErr(error)}</Notice>;
  if (!ctx) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <RaiseForm
        target={target}
        context={ctx}
        canOpen={canOpen}
        onRaised={(r) => {
          setDone(r);
          onRaised();
        }}
        onCancel={onClose}
      />
      <RaisedList items={mine} canOpen={canOpen} />
    </div>
  );
}

/** The form. Exported so the markup (and the pure pieces it is made of) can be tested. */
export function RaiseForm({
  target,
  context,
  canOpen,
  onRaised,
  onCancel,
  initial,
}: {
  target: RaiseTarget;
  context: RaiseContext;
  canOpen: boolean;
  onRaised: (r: { reference: string; id?: string }) => void;
  onCancel: () => void;
  /** For tests and previews. */
  initial?: { typeKey?: string; whenEarlier?: boolean; error?: string; duplicate?: string | null };
}) {
  const t = useTranslations("Compliance.raise");
  const tErr = useTranslations("Compliance.errors");
  const tType = useTranslations("Compliance");
  const locale = useLocale();
  const first = context.types.find((x) => !context.open.includes(x.key)) ?? context.types[0];
  const [typeKey, setTypeKey] = useState(initial?.typeKey ?? first?.key ?? "");
  const type = context.types.find((x) => x.key === typeKey) ?? null;
  const fields: FieldDef[] = type?.fields ?? [];
  const [values, setValues] = useState<FormValues>(() => emptyForm(fields));
  const [name, setName] = useState(context.contact?.name ?? "");
  const [email, setEmail] = useState(context.contact?.email ?? "");
  const [phone, setPhone] = useState(context.contact?.phone ?? "");
  const [channel, setChannel] = useState(context.channel ?? "");
  const [earlier, setEarlier] = useState(initial?.whenEarlier ?? false);
  const [at, setAt] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initial?.error ?? null);
  const [duplicate, setDuplicate] = useState<string | null>(initial?.duplicate ?? null);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());

  const pick = (key: string) => {
    setTypeKey(key);
    setValues(emptyForm(context.types.find((x) => x.key === key)?.fields ?? []));
    setInvalid(new Set());
    setError(null);
    setDuplicate(null);
  };

  const missing = missingRequired(fields, values);
  const isoAt = earlier ? localInputToIso(at) : "";
  const whenOk = !earlier || (isoAt !== "" && reason.trim() !== "");
  const alreadyOpen = !!type && context.open.includes(type.key);
  const ready = !!type && name.trim() !== "" && missing.length === 0 && whenOk && !alreadyOpen && !busy;
  const hasEmail = email.trim() !== "";
  const label = (x: { label: string; labelL10n: Partial<Record<"ms" | "zh" | "ko", string>> }) => (x.labelL10n as Record<string, string | undefined>)[locale] || x.label;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!type || !ready) return;
    setBusy(true);
    setError(null);
    setDuplicate(null);
    setInvalid(new Set());
    const res = await raiseRequest({
      typeKey: type.key,
      ...target,
      customerName: name,
      customerEmail: email,
      customerPhone: phone,
      channel,
      ...(isoAt ? { receivedAt: isoAt, receivedAtReason: reason } : {}),
      note,
      notify: notify && hasEmail,
      answers: answersFromForm(fields, values),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorKey(res.code));
      setInvalid(new Set((res.issues ?? []).map((i) => i.field ?? "")));
      // a person who holds a compliance permission is told which request it is
      const ref = res.code === "duplicate_open" ? (res.issues ?? []).find((i) => i.field === "reference")?.code : undefined;
      if (ref) setDuplicate(ref);
      return;
    }
    onRaised({ reference: res.data.reference, id: res.data.id });
  };

  if (!type) return <Notice>{t("noTypes")}</Notice>;

  return (
    <form onSubmit={submit} aria-label={t("title")} className="space-y-4">
      <div>
        <label htmlFor="cmp-rs-type" className="mb-1 block text-sm font-medium text-foreground">{t("type")}</label>
        <select id="cmp-rs-type" className={SELECT} value={typeKey} onChange={(e) => pick(e.target.value)}>
          {context.types.map((x) => (
            <option key={x.key} value={x.key}>{label(x)}</option>
          ))}
        </select>
        {alreadyOpen ? (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {t("openExists")}
          </p>
        ) : null}
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-semibold text-foreground">{t("customer")}</legend>
        <div className="sm:col-span-2">
          <label htmlFor="cmp-rs-name" className="mb-1 block text-sm font-medium text-foreground">{t("name")} <span className="text-destructive">*</span></label>
          <Input id="cmp-rs-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoComplete="off" aria-invalid={invalid.has("customer_name") || undefined} />
        </div>
        <div>
          <label htmlFor="cmp-rs-phone" className="mb-1 block text-sm font-medium text-foreground">{t("phone")}</label>
          <Input id="cmp-rs-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} autoComplete="off" aria-invalid={invalid.has("customer_phone") || undefined} />
        </div>
        <div>
          <label htmlFor="cmp-rs-email" className="mb-1 block text-sm font-medium text-foreground">{t("email")}</label>
          <Input id="cmp-rs-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} autoComplete="off" aria-invalid={invalid.has("customer_email") || undefined} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="cmp-rs-channel" className="mb-1 block text-sm font-medium text-foreground">{t("channel")}</label>
          <Input id="cmp-rs-channel" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder={t("channelPlaceholder")} maxLength={60} autoComplete="off" />
        </div>
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-semibold text-foreground">{t("details")}</legend>
        <p className="text-xs text-muted-foreground">{t("tickHelp")}</p>
        {fields.map((f) => (
          <FieldInput key={`${type.key}-${f.key}`} idPrefix="cmp-rs" field={f} value={values[f.key] ?? (f.type === "acknowledge" ? false : "")} onChange={(v) => setValues({ ...values, [f.key]: v })} invalid={invalid.has(f.key)} />
        ))}
        {fields.length === 0 ? <p className="text-sm text-muted-foreground">{tType("none")}</p> : null}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold text-foreground">{t("when")}</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="cmp-rs-when" checked={!earlier} onChange={() => setEarlier(false)} className="size-4 accent-[var(--primary)]" />
            {t("whenNow")}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="cmp-rs-when" checked={earlier} onChange={() => setEarlier(true)} className="size-4 accent-[var(--primary)]" />
            {t("whenEarlier")}
          </label>
        </div>
        {earlier ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="cmp-rs-at" className="mb-1 block text-sm font-medium text-foreground">{t("whenAt")} <span className="text-destructive">*</span></label>
              <Input id="cmp-rs-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="cmp-rs-reason" className="mb-1 block text-sm font-medium text-foreground">{t("whenReason")} <span className="text-destructive">*</span></label>
              <Textarea id="cmp-rs-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} aria-invalid={invalid.has("received_at_reason") || undefined} />
              <p className="mt-1 text-xs text-muted-foreground">{t("whenReasonHelp")}</p>
            </div>
          </div>
        ) : null}
      </fieldset>

      <div>
        <label htmlFor="cmp-rs-note" className="mb-1 block text-sm font-medium text-foreground">{t("note")}</label>
        <Textarea id="cmp-rs-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} />
      </div>

      <div>
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input type="checkbox" checked={notify && hasEmail} disabled={!hasEmail} onChange={(e) => setNotify(e.target.checked)} className="mt-0.5 size-4 accent-[var(--primary)]" />
          <span>{t("notify")}</span>
        </label>
        {!hasEmail ? <p className="mt-1 text-xs text-muted-foreground">{t("notifyNoEmail")}</p> : null}
      </div>

      {error ? (
        <Notice tone="danger" icon={null}>
          {tErr(error)}
          {duplicate ? ` ${t("openExistsRef", { reference: duplicate })}` : ""}
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!ready}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {busy ? t("submitting") : t("submit")}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>{t("cancel")}</Button>
        {canOpen ? null : <span className="text-xs text-muted-foreground">{t("followHint")}</span>}
      </div>
    </form>
  );
}
