"use client";

// ============================================================
// Doc Sign, registration page (/r/<slug>): the form a stranger fills, mostly on a phone. A few details (the
// ones the workspace chose), the agreement with a required tick, one big button, and a calm "check your email"
// when it is taken. Plain words in the person's language, every message next to what it is about, large touch
// targets, labels that stay, errors read out and the first wrong field focused.
//
// What it posts, and what it never does:
//   - the details, the agreement, the language, the page's signed token, the Turnstile token when there is one,
//     and the hidden field a person never fills (a script that fills every input is told apart by it);
//   - it never puts a detail in the address (the inputs carry no `name`, so even a submit before the page has
//     loaded sends nothing), never shows a link, and cannot tell whether an address was known.
// ============================================================

import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { AlertTriangle, CheckCircle2, Clock, FileX, Loader2, MailCheck } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DETAIL_ORDER, EMPTY_VALUES, FINAL_NOTICES, firstProblem, precheck, readAnswer, type Detail, type NoticeCode, type Problems, type Values } from "@/lib/sign/client/register-flow";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import type { RegisterView } from "@/lib/sign/service/registration";
import { cn } from "@/lib/utils";

import { useTurnstile } from "./use-turnstile";

type Phase = { kind: "form" } | { kind: "done"; email: string } | { kind: "notice"; code: NoticeCode };

export function RegisterForm({ view, locale }: { view: RegisterView; locale: SignerLocale }) {
  const t = useTranslations("Sign.register");
  const [values, setValues] = useState<Values>(EMPTY_VALUES);
  const [honeypot, setHoneypot] = useState("");
  const [problems, setProblems] = useState<Problems>({});
  const [token, setToken] = useState(view.token);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const turnstile = useTurnstile(view.captchaKey, locale);

  const refs: Record<Exclude<Detail, "consent">, RefObject<HTMLInputElement | null>> = {
    full_name: useRef<HTMLInputElement>(null),
    company: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    phone: useRef<HTMLInputElement>(null),
  };
  const consentRef = useRef<HTMLInputElement>(null);

  const focusFirst = (found: Problems) => {
    const first = firstProblem(found);
    if (!first) return;
    // after the page has re-drawn with the messages
    window.setTimeout(() => (first === "consent" ? consentRef : refs[first]).current?.focus(), 0);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const found = precheck(values, view.asked);
    if (Object.keys(found).length > 0) {
      setProblems(found);
      setBanner("invalid");
      focusFirst(found);
      return;
    }
    setProblems({});
    setBanner(null);
    setBusy(true);
    let taken = false;
    try {
      const res = await fetch(`/api/sign/register/${encodeURIComponent(view.slug)}`, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName: values.fullName, company: values.company, email: values.email, phone: values.phone, consent: values.consent, locale, token, captcha: turnstile.token, website_url: honeypot }),
      });
      const answer = readAnswer(res.status, await res.json().catch(() => null));
      if (answer.kind === "ok") {
        taken = true;
        setPhase({ kind: "done", email: values.email.trim() });
      } else if (answer.kind === "problems") {
        setProblems(answer.problems);
        setBanner("invalid");
        focusFirst(answer.problems);
      } else if (answer.kind === "retry") {
        if (answer.token) setToken(answer.token);
        setBanner(answer.code);
      } else if (FINAL_NOTICES.includes(answer.code)) {
        taken = true;
        setPhase({ kind: "notice", code: answer.code });
      } else {
        setBanner(answer.code);
      }
    } catch {
      setBanner("network");
    } finally {
      setBusy(false);
      // a Turnstile token works once
      if (!taken && turnstile.enabled) turnstile.reset();
    }
  };

  if (phase.kind === "done") return <Done view={view} locale={locale} email={phase.email} />;
  if (phase.kind === "notice") return <Notice code={phase.code} workspace={view.workspace.name} />;

  const set = <K extends keyof Values>(key: K, value: Values[K]) => setValues((v) => ({ ...v, [key]: value }));
  const waitingForCheck = turnstile.enabled && !turnstile.token;

  return (
    <section aria-labelledby="register-title" className="mx-auto w-full max-w-md">
      <h1 id="register-title" className="text-2xl font-semibold leading-snug">
        {t("title")}
      </h1>
      <p className="mt-2 text-muted-foreground">{view.sendsDocument ? (view.documentMode === "form" ? t("intro.form") : t("intro.document")) : t("intro.details")}</p>

      <form noValidate onSubmit={submit} className="mt-6 space-y-5">
        {banner ? (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{t(`errors.${banner}`)}</span>
          </p>
        ) : null}

        {DETAIL_ORDER.filter((d): d is Exclude<Detail, "consent"> => d !== "consent" && view.asked[d] !== "off").map((detail) => (
          <DetailField
            key={detail}
            detail={detail}
            level={view.asked[detail]}
            value={detail === "full_name" ? values.fullName : detail === "company" ? values.company : values[detail]}
            onChange={(v) => set(detail === "full_name" ? "fullName" : detail, v)}
            problem={problems[detail]}
            inputRef={refs[detail]}
          />
        ))}

        {/* The hidden field: a person never sees or reaches it, a script that fills every input does. */}
        <div aria-hidden="true" className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
          <label>
            {t("honeypot")}
            <input type="text" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </label>
        </div>

        <div className={cn("rounded-lg border p-3", problems.consent ? "border-destructive" : "border-border")}>
          <label htmlFor="register-consent" className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
            <input
              id="register-consent"
              ref={consentRef}
              type="checkbox"
              checked={values.consent}
              onChange={(e) => set("consent", e.target.checked)}
              aria-required="true"
              aria-invalid={problems.consent ? true : undefined}
              aria-describedby={problems.consent ? "register-consent-error" : undefined}
              className="mt-0.5 size-6 shrink-0 accent-[var(--primary)]"
            />
            <span>{view.consent[locale]}</span>
          </label>
          {problems.consent ? (
            <p id="register-consent-error" className="mt-2 text-sm text-destructive">
              {t("problems.consent.required")}
            </p>
          ) : null}
        </div>

        {turnstile.enabled ? (
          <div>
            <div ref={turnstile.container} />
            {turnstile.failed ? (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {t("captcha.failed")}
              </p>
            ) : null}
          </div>
        ) : null}

        <Button type="submit" className="h-12 w-full text-base" disabled={busy || waitingForCheck}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {busy ? t("sending") : t("send")}
        </Button>
        {waitingForCheck && !turnstile.failed ? (
          <p role="status" className="text-center text-xs text-muted-foreground">
            {t("captcha.waiting")}
          </p>
        ) : null}
      </form>
    </section>
  );
}

// ---- one detail -----------------------------------------------------------------------------------------

const FIELD_ATTRS: Record<Exclude<Detail, "consent">, { autoComplete: string; type: string; inputMode?: "email" | "tel" | "text"; max: number }> = {
  full_name: { autoComplete: "name", type: "text", max: 120 },
  company: { autoComplete: "organization", type: "text", max: 160 },
  email: { autoComplete: "email", type: "email", inputMode: "email", max: 254 },
  phone: { autoComplete: "tel", type: "tel", inputMode: "tel", max: 32 },
};

function DetailField({ detail, level, value, onChange, problem, inputRef }: { detail: Exclude<Detail, "consent">; level: "required" | "optional" | "off"; value: string; onChange: (v: string) => void; problem?: "required" | "too_long" | "invalid"; inputRef: RefObject<HTMLInputElement | null> }) {
  const t = useTranslations("Sign.register");
  const id = `register-${detail}`;
  const attrs = FIELD_ATTRS[detail];
  const hint = detail === "email" ? t("fields.email.hint") : detail === "phone" ? t("fields.phone.hint") : null;
  const describedBy = [hint ? `${id}-hint` : null, problem ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {t(`fields.${detail}.label`)}
        {level === "optional" ? <span className="ml-1 font-normal text-muted-foreground">{t("optional")}</span> : null}
      </label>
      <Input
        id={id}
        ref={inputRef}
        type={attrs.type}
        inputMode={attrs.inputMode}
        autoComplete={attrs.autoComplete}
        maxLength={attrs.max}
        placeholder={detail === "phone" ? t("fields.phone.placeholder") : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-required={level === "required" ? true : undefined}
        aria-invalid={problem ? true : undefined}
        aria-describedby={describedBy}
        className="h-12 text-base"
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {problem ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {t(`problems.${detail}.${problem}`)}
        </p>
      ) : null}
    </div>
  );
}

// ---- the ends ---------------------------------------------------------------------------------------------

function Frame({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section role="status" className="mx-auto flex max-w-md flex-col items-center gap-4 py-10 text-center">
      {icon}
      <h1 className="text-2xl font-semibold leading-snug">{title}</h1>
      <div className="space-y-3 text-muted-foreground">{children}</div>
    </section>
  );
}

function Done({ view, locale, email }: { view: RegisterView; locale: SignerLocale; email: string }) {
  const t = useTranslations("Sign.register");
  const custom = view.success[locale]?.trim();
  if (!view.sendsDocument) {
    return (
      <Frame icon={<CheckCircle2 className="size-12 text-emerald-600 dark:text-emerald-400" aria-hidden />} title={t("success.detailsTitle")}>
        <p className="whitespace-pre-line">{custom || t("success.detailsBody")}</p>
      </Frame>
    );
  }
  return (
    <Frame icon={<MailCheck className="size-12 text-emerald-600 dark:text-emerald-400" aria-hidden />} title={t("success.documentTitle")}>
      <p>{view.documentMode === "form" ? t("success.formBody", { email }) : t("success.documentBody", { email })}</p>
      {custom ? <p className="whitespace-pre-line">{custom}</p> : null}
      <p className="text-sm">{t("success.spam")}</p>
    </Frame>
  );
}

function Notice({ code, workspace }: { code: NoticeCode; workspace: string }) {
  const t = useTranslations("Sign.register");
  const key = code === "form_cap" || code === "send_failed" || code === "unavailable" || code === "not_found" ? code : "unavailable";
  const Icon = key === "form_cap" ? Clock : key === "not_found" ? FileX : AlertTriangle;
  return (
    <Frame icon={<Icon className="size-12 text-muted-foreground" aria-hidden />} title={t(`notice.${key}.title`)}>
      <p>{t(`notice.${key}.body`, { workspace })}</p>
    </Frame>
  );
}
