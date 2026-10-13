"use client";

// ============================================================
// The parent form (/c/<slug>): confirm an email address with a code, fill the closure or the withdrawal form, see the confirmation. Its own minimal frame
// (not the dashboard): the workspace's name and logo, a language choice (English, Bahasa Melayu, Chinese, Korean), the page, a quiet footer. Mostly read
// on a phone: one column, large touch targets, the keyboard type each field needs, nothing that needs a hover.
//
// What this page never does: show anything stored (it holds only what the person typed in this tab, and the address it kept in session storage for a
// refresh), say whether an address or a request is known, or mention the regulatory stop. The words are lib/compliance/public/words.ts.
// ============================================================

import { CheckCircle2, Info, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { useTurnstile } from "@/components/sign/register/use-turnstile";
import { useLanguage } from "@/components/sign/signer/use-language";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { linkWords } from "@/lib/compliance/chat-link/link-words";
import type { LinkView } from "@/lib/compliance/chat-link/types";
import { maskEmail } from "@/lib/compliance/public/amount";
import { OTHER_BANK } from "@/lib/compliance/public/banks";
import type { PublicView } from "@/lib/compliance/public/settings-types";
import type { PublicFieldId, PublicProblems } from "@/lib/compliance/public/validate";
import { ALL_PUBLIC_WORDS, LANGUAGE_NAMES, fillWords, publicWords, type PublicWords } from "@/lib/compliance/public/words";
import type { CustomerLocale } from "@/lib/compliance/types";
import { cn } from "@/lib/utils";

import {
  EMAIL_STORAGE_KEY,
  buildForm,
  checkBeforeSending,
  emptyValues,
  firstProblem,
  holderLabel,
  isOtherBank,
  letterNeeded,
  linkIsGone,
  problemText,
  startStep,
  submitErrorKey,
  verifyErrorKey,
  wrongCodeText,
  type FormValues,
  type PickedFiles,
  type Step,
} from "./flow";

const LANGUAGE_ORDER: CustomerLocale[] = ["en", "ms", "zh", "ko"];
const SELECT = "h-12 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const TICK = "mt-1 size-5 shrink-0 accent-[var(--primary)]";

// ---- the frame ---------------------------------------------------------------------------------------------------------

interface RootProps {
  view: PublicView;
  initialLocale: CustomerLocale;
  /** For tests and previews: start on a given step. */
  initial?: { step?: Step; email?: string; reference?: string | null; values?: Partial<FormValues> };
}

export function PublicRoot({ view, initialLocale, initial }: RootProps) {
  const [locale, setLocale] = useLanguage(initialLocale);
  const words = publicWords(locale);
  return (
    <div lang={locale}>
      <Frame workspace={view.workspace} words={words} locale={locale} onLocale={setLocale}>
        <PublicFlow view={view} locale={locale} words={words} initial={initial} />
      </Frame>
    </div>
  );
}

/** A page that is not available (unknown, switched off, Compliance off, no key): the same words for all of them, and no workspace named. */
export function PublicNotAvailable({ initialLocale, busy = false }: { initialLocale: CustomerLocale; busy?: boolean }) {
  const [locale, setLocale] = useLanguage(initialLocale);
  const words = publicWords(locale);
  const t = busy ? words.busy : words.unavailable;
  return (
    <div lang={locale}>
      <Frame workspace={null} words={words} locale={locale} onLocale={setLocale}>
        <section className="mx-auto flex max-w-md flex-col items-center gap-4 py-10 text-center" aria-labelledby="cmp-na-title">
          <Info className="size-12 text-muted-foreground" aria-hidden />
          <h1 id="cmp-na-title" className="text-2xl font-semibold leading-snug">{t.title}</h1>
          <p className="text-muted-foreground">{t.body}</p>
        </section>
      </Frame>
    </div>
  );
}

function Frame({ workspace, words, locale, onLocale, children }: { workspace: { name: string; logoUrl: string | null } | null; words: PublicWords; locale: CustomerLocale; onLocale: (l: CustomerLocale) => void; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <a href="#cmp-main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-foreground">
        {words.skip}
      </a>
      <header className="border-b bg-card">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2.5">
            {workspace?.logoUrl ? (
              // the workspace's own logo, from wherever they keep it
              // eslint-disable-next-line @next/next/no-img-element
              <img src={workspace.logoUrl} alt={workspace.name} className="h-9 max-w-[7rem] shrink-0 object-contain" referrerPolicy="no-referrer" />
            ) : null}
            {workspace?.name ? <span className="block truncate text-sm font-semibold">{workspace.name}</span> : null}
          </div>
          <label className="flex shrink-0 items-center">
            <span className="sr-only">{words.language}</span>
            <select value={locale} onChange={(e) => onLocale(e.target.value as CustomerLocale)} className="h-11 max-w-[9.5rem] rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
              {LANGUAGE_ORDER.map((code) => (
                <option key={code} value={code} lang={code}>
                  {LANGUAGE_NAMES[code]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      <main id="cmp-main" tabIndex={-1} className="mx-auto w-full max-w-2xl flex-1 px-3 py-6 outline-none">
        {children}
      </main>
      <footer className="px-3 py-4 text-center text-xs text-muted-foreground">{workspace?.name ? fillWords(words.footer, { workspace: workspace.name }) : null}</footer>
    </div>
  );
}

// ---- the flow ---------------------------------------------------------------------------------------------------------

interface FlowProps {
  view: PublicView;
  locale: CustomerLocale;
  words: PublicWords;
  initial?: RootProps["initial"];
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      // not JSON: the status decides
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { code: "network" } };
  }
}

const readSavedEmail = (): string => {
  try {
    return window.sessionStorage.getItem(EMAIL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveEmail = (email: string) => {
  try {
    if (email) window.sessionStorage.setItem(EMAIL_STORAGE_KEY, email);
    else window.sessionStorage.removeItem(EMAIL_STORAGE_KEY);
  } catch {
    // only a convenience for a refresh
  }
};

function PublicFlow({ view, locale, words, initial }: FlowProps) {
  const [step, setStep] = useState<Step>(initial?.step ?? startStep(view.sessionActive));
  const [email, setEmail] = useState(initial?.email ?? "");
  const [token, setToken] = useState(view.token);
  // the address kept for a refresh is read after the page has been drawn (the server draws it without)
  useEffect(() => {
    // reads the browser's session storage, which the server cannot, so it can only be done once the page is in the browser
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEmail((e) => e || readSavedEmail());
  }, []);
  const [reference, setReference] = useState<string | null>(initial?.reference ?? null);
  const base = `/api/compliance/public/${view.slug}`;
  const progress: Step[] = ["verify", "form", "done"];
  const at = Math.max(0, progress.indexOf(step === "declined" ? "form" : step));

  return (
    <div className="space-y-5">
      <ol className="flex items-center gap-2 text-xs text-muted-foreground" aria-label={words.step.details}>
        {([["verify", words.step.verify], ["form", words.step.details], ["done", words.step.done]] as const).map(([k, label], i) => (
          <li key={k} className={cn("flex items-center gap-1.5", i === at && "font-semibold text-foreground")} aria-current={i === at ? "step" : undefined}>
            <span className={cn("flex size-5 items-center justify-center rounded-full border text-[10px]", i <= at ? "border-primary bg-primary text-primary-foreground" : "border-border")}>{i + 1}</span>
            {label}
            {i < 2 ? <span aria-hidden className="mx-1 h-px w-4 bg-border" /> : null}
          </li>
        ))}
      </ol>

      {step === "verify" ? (
        <VerifyStep
          view={view}
          locale={locale}
          words={words}
          base={base}
          initialEmail={email}
          onVerified={(e) => {
            saveEmail(e);
            setEmail(e);
            setStep("form");
          }}
        />
      ) : null}

      {step === "form" ? (
        <RequestStep
          view={view}
          locale={locale}
          words={words}
          base={base}
          email={email}
          token={token}
          initialValues={initial?.values}
          onToken={setToken}
          onDeclined={() => setStep("declined")}
          onSessionEnded={() => {
            saveEmail("");
            setStep("verify");
          }}
          onDone={(ref) => {
            setReference(ref);
            setStep("done");
          }}
        />
      ) : null}

      {step === "declined" ? (
        <section className="space-y-3 rounded-xl border border-border p-4" aria-labelledby="cmp-declined">
          <h1 id="cmp-declined" className="text-xl font-semibold">{words.closure.declined.title}</h1>
          <p>{words.closure.declined.body}</p>
          <Button type="button" variant="outline" className="h-12 px-5 text-base" onClick={() => setStep("form")}>
            {words.closure.declined.back}
          </Button>
        </section>
      ) : null}

      {step === "done" ? <DoneStep view={view} words={words} email={email} reference={reference} /> : null}
    </div>
  );
}

// ---- the personal closure form (migration 185): /c/link/<token> ---------------------------------------------------------------------------

/** The one page for a link that does not work, whatever the reason. It does not name the workspace and says nothing about why. */
export function LinkNotValid({ initialLocale }: { initialLocale: CustomerLocale }) {
  const [locale, setLocale] = useLanguage(initialLocale);
  const words = publicWords(locale);
  return (
    <div lang={locale}>
      <Frame workspace={null} words={words} locale={locale} onLocale={setLocale}>
        <LinkGone locale={locale} />
      </Frame>
    </div>
  );
}

function LinkGone({ locale }: { locale: CustomerLocale }) {
  const lw = linkWords(locale);
  return (
    <section className="mx-auto flex max-w-md flex-col items-center gap-4 py-10 text-center" aria-labelledby="cmp-gone-title">
      <Info className="size-12 text-muted-foreground" aria-hidden />
      <h1 id="cmp-gone-title" className="text-2xl font-semibold leading-snug">{lw.invalid.title}</h1>
      <p className="text-muted-foreground">{lw.invalid.body}</p>
    </section>
  );
}

type LinkStep = "form" | "declined" | "done" | "gone";

export function LinkRoot({ view, initialLocale, initial }: { view: LinkView; initialLocale: CustomerLocale; initial?: { step?: LinkStep; reference?: string | null; values?: Partial<FormValues> } }) {
  const [locale, setLocale] = useLanguage(initialLocale);
  const words = publicWords(locale);
  return (
    <div lang={locale}>
      <Frame workspace={view.workspace} words={words} locale={locale} onLocale={setLocale}>
        <LinkFlow view={view} locale={locale} words={words} initial={initial} />
      </Frame>
    </div>
  );
}

function LinkFlow({ view, locale, words, initial }: { view: LinkView; locale: CustomerLocale; words: PublicWords; initial?: { step?: LinkStep; reference?: string | null; values?: Partial<FormValues> } }) {
  const [step, setStep] = useState<LinkStep>(initial?.step ?? "form");
  const [token, setToken] = useState(view.token);
  const [reference, setReference] = useState<string | null>(initial?.reference ?? null);
  const lw = linkWords(locale);
  // the same closure form as the public one: the page is drawn from a view of the same shape
  const pv: PublicView = { slug: "", type: "closure", workspace: view.workspace, notice: {}, maxAmount: 0, banks: view.banks, targetDays: view.targetDays, token, captchaKey: null, sessionActive: true };
  if (step === "gone") return <LinkGone locale={locale} />;
  const at = step === "done" ? 1 : 0;
  return (
    <div className="space-y-5">
      <ol className="flex items-center gap-2 text-xs text-muted-foreground" aria-label={lw.step.form}>
        {([["form", lw.step.form], ["done", lw.step.done]] as const).map(([k, label], i) => (
          <li key={k} className={cn("flex items-center gap-1.5", i === at && "font-semibold text-foreground")} aria-current={i === at ? "step" : undefined}>
            <span className={cn("flex size-5 items-center justify-center rounded-full border text-[10px]", i <= at ? "border-primary bg-primary text-primary-foreground" : "border-border")}>{i + 1}</span>
            {label}
            {i < 1 ? <span aria-hidden className="mx-1 h-px w-4 bg-border" /> : null}
          </li>
        ))}
      </ol>

      {step === "form" ? (
        <RequestStep
          view={pv}
          locale={locale}
          words={words}
          base=""
          email=""
          token={token}
          initialValues={initial?.values}
          onToken={setToken}
          onDeclined={() => setStep("declined")}
          onSessionEnded={() => setStep("gone")}
          onDone={(ref) => {
            setReference(ref);
            setStep("done");
          }}
          link={{ linkToken: view.linkToken, maskedPhone: view.maskedPhone, name: view.name, email: view.email, onGone: () => setStep("gone") }}
        />
      ) : null}

      {step === "declined" ? (
        <section className="space-y-3 rounded-xl border border-border p-4" aria-labelledby="cmp-declined">
          <h1 id="cmp-declined" className="text-xl font-semibold">{words.closure.declined.title}</h1>
          <p>{words.closure.declined.body}</p>
          <Button type="button" variant="outline" className="h-12 px-5 text-base" onClick={() => setStep("form")}>
            {words.closure.declined.back}
          </Button>
        </section>
      ) : null}

      {step === "done" ? <DoneStep view={pv} words={words} email="" reference={reference} /> : null}
    </div>
  );
}

// ---- step 1: the address and the code -------------------------------------------------------------------------------

function VerifyStep({ view, locale, words, base, initialEmail, onVerified }: { view: PublicView; locale: CustomerLocale; words: PublicWords; base: string; initialEmail: string; onVerified: (email: string) => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<"ask" | "code">("ask");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { container: captchaBox, token: captchaToken, enabled: captchaOn, reset: resetCaptcha } = useTurnstile(view.captchaKey, locale);
  const askForm = useRef<HTMLFormElement>(null);
  const idEmail = useId();
  const idCode = useId();
  const hint = useId();

  const ask = async () => {
    setBusy(true);
    setError(null);
    const res = await postJson(`${base}/code`, { email: email.trim(), locale, captcha: captchaToken, website: (askForm.current?.elements.namedItem("website") as HTMLInputElement | null)?.value ?? "" });
    setBusy(false);
    resetCaptcha();
    if (res.ok) {
      setPhase("code");
      setCode("");
      return;
    }
    setError(words.verify.errors[verifyErrorKey(String(res.data.code ?? ""))]);
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const res = await postJson(`${base}/verify`, { email: email.trim(), code: code.trim() });
    setBusy(false);
    if (res.ok) {
      onVerified(email.trim().toLowerCase());
      return;
    }
    const c = String(res.data.code ?? "");
    setError(c === "wrong_code" ? wrongCodeText(words, Number(res.data.attemptsLeft ?? 0)) : words.verify.errors[verifyErrorKey(c)]);
  };

  return (
    <section className="space-y-4" aria-labelledby="cmp-verify-title">
      <h1 id="cmp-verify-title" className="text-xl font-semibold leading-snug">{words.verify.title}</h1>
      <p className="text-muted-foreground">{words.verify.intro}</p>
      <NoticeBlock view={view} locale={locale} />

      {phase === "ask" ? (
        <form
          ref={askForm}
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
          <div>
            <label htmlFor={idEmail} className="mb-1 block text-sm font-medium">{words.verify.emailLabel}</label>
            <Input id={idEmail} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} className="h-12 text-base" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} required />
          </div>
          <HoneyField />
          {captchaOn ? <div ref={captchaBox} /> : null}
          {error ? <ErrorLine text={error} /> : null}
          <Button type="submit" className="h-12 w-full text-base" disabled={busy || email.trim() === "" || (captchaOn && !captchaToken)}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {busy ? words.verify.sending : words.verify.send}
          </Button>
        </form>
      ) : (
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <p role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">{words.verify.sentTo.replace("{email}", maskEmail(email.trim().toLowerCase()))}</p>
          <div>
            <label htmlFor={idCode} className="mb-1 block text-sm font-medium">{words.verify.codeLabel}</label>
            <Input
              id={idCode}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              className="h-14 text-center text-2xl tracking-[0.5em]"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              aria-describedby={hint}
            />
            <p id={hint} className="mt-1 text-xs text-muted-foreground">{words.verify.codeHelp}</p>
          </div>
          {error ? <ErrorLine text={error} /> : null}
          <Button type="submit" className="h-12 w-full text-base" disabled={busy || code.length !== 6}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {busy ? words.verify.confirming : words.verify.confirm}
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" className="h-11" onClick={() => void ask()} disabled={busy}>
              {words.verify.resend}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-11"
              onClick={() => {
                setPhase("ask");
                setError(null);
              }}
            >
              {words.verify.change}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

// ---- step 2: the request ---------------------------------------------------------------------------------------------

function RequestStep({
  view,
  locale,
  words,
  base,
  email,
  token,
  initialValues,
  onToken,
  onDeclined,
  onSessionEnded,
  onDone,
  link,
}: {
  view: PublicView;
  locale: CustomerLocale;
  words: PublicWords;
  base: string;
  email: string;
  token: string;
  initialValues?: Partial<FormValues>;
  onToken: (t: string) => void;
  onDeclined: () => void;
  onSessionEnded: () => void;
  onDone: (reference: string | null) => void;
  /**
   * The personal closure form (migration 185): no emailed code, the email is typed here, the registered phone number is shown masked and not editable, and
   * the post goes to the link's own route. `onGone` shows the one calm page when the server says the link is no good (whatever the reason).
   */
  link?: { linkToken: string; maskedPhone: string | null; name: string; email: string; onGone: () => void };
}) {
  const closure = view.type === "closure";
  const lw = linkWords(locale);
  const [values, setValues] = useState<FormValues>(() => ({ ...emptyValues(), ...(link ? { name: link.name } : {}), ...initialValues }));
  const [files, setFiles] = useState<PickedFiles>({});
  const [problems, setProblems] = useState<PublicProblems>({});
  const [typedEmail, setTypedEmail] = useState(link?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const retried = useRef(false);
  const rules = { maxAmount: view.maxAmount, banks: view.banks, phoneFromCase: !!link?.maskedPhone };
  const set = <K extends keyof FormValues>(k: K, v: FormValues[K]) => {
    setValues((s) => ({ ...s, [k]: v }));
    setProblems((p) => (p[k as PublicFieldId] ? { ...p, [k]: undefined } : p));
  };
  const showFields = !closure || values.wantClose === "yes";
  const needLetter = letterNeeded(values);

  const focusFirst = (p: PublicProblems) => {
    const id = firstProblem(p);
    if (!id) return;
    window.setTimeout(() => (formRef.current?.querySelector(`[data-field="${id}"]`) as HTMLElement | null)?.focus(), 0);
  };

  const honey = () => (formRef.current?.elements.namedItem("website") as HTMLInputElement | null)?.value ?? "";

  const send = async (tokenToUse: string) => {
    setBusy(true);
    setBanner(null);
    let res: Response;
    try {
      res = await fetch(link ? "/api/compliance/form-link/submit" : `${base}/submit`, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        body: buildForm(values, { token: tokenToUse, email: (link ? typedEmail : email || typedEmail).trim().toLowerCase(), locale, ...(link ? { linkToken: link.linkToken } : {}) }, files, honey()),
      });
    } catch {
      setBusy(false);
      setBanner(words.form.errors.network);
      return;
    }
    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      // not JSON: the status decides
    }
    setBusy(false);
    if (res.ok) {
      if (data.declined === true) onDeclined();
      else onDone(typeof data.reference === "string" ? data.reference : null);
      return;
    }
    const code = String(data.code ?? "");
    // the personal form only: a link that no longer works (used, withdrawn, replaced, expired) is the one calm page, whatever the reason
    if (link && linkIsGone(code)) {
      link.onGone();
      return;
    }
    if (code === "invalid" && data.problems && typeof data.problems === "object") {
      const p = data.problems as PublicProblems;
      setProblems(p);
      setBanner(words.form.fixAbove);
      focusFirst(p);
      return;
    }
    if (typeof data.token === "string" && data.token) {
      onToken(data.token);
      // too fast: wait a few seconds and send once more with the fresh token; any other token problem is the person's to retry
      if (code === "token_too_fast" && !retried.current) {
        retried.current = true;
        setBusy(true);
        window.setTimeout(() => void send(data.token as string), 4000);
        return;
      }
    }
    if (code === "session_invalid") {
      onSessionEnded();
      return;
    }
    setBanner(words.form.errors[submitErrorKey(code || (res.status === 413 ? "too_large" : ""))]);
  };

  const submit = () => {
    retried.current = false;
    const found = checkBeforeSending(view.type, values, files, rules, link ? { email: typedEmail } : {});
    setProblems(found);
    if (Object.keys(found).length > 0) {
      setBanner(words.form.fixAbove);
      focusFirst(found);
      return;
    }
    void send(token);
  };

  const days = view.targetDays;
  const t = closure ? words.closure : words.withdrawal;

  return (
    <section className="space-y-5" aria-labelledby="cmp-form-title">
      <h1 id="cmp-form-title" className="text-xl font-semibold leading-snug">{t.title}</h1>
      <NoticeBlock view={view} locale={locale} />

      {closure ? (
        <div className="space-y-3 rounded-xl border border-[light-dark(#fcd34d,#92400e)] bg-[light-dark(#fffbeb,#451a03)] p-4 text-sm text-[light-dark(#451a03,#fef3c7)]" role="note">
          <p className="flex items-start gap-2 font-medium"><TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{words.closure.warning}</p>
          <p>{words.closure.childOnly}</p>
          {days ? <p>{fillWords(words.closure.aim, { days })}</p> : null}
        </div>
      ) : (
        <p className="rounded-xl bg-muted p-3 text-sm">{words.withdrawal.note}</p>
      )}

      <form
        ref={formRef}
        noValidate
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {closure ? (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-base font-medium">{words.closure.wantClose}</legend>
            {(["yes", "no"] as const).map((v) => (
              <label key={v} className={cn("flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2", values.wantClose === v ? "border-primary bg-primary/5" : "border-border")}>
                <input
                  type="radio"
                  name="wantClose"
                  value={v}
                  data-field={v === "yes" ? "wantClose" : undefined}
                  checked={values.wantClose === v}
                  onChange={() => {
                    set("wantClose", v);
                    if (v === "no") onDeclined();
                  }}
                  className="size-5 accent-[var(--primary)]"
                />
                <span>{v === "yes" ? words.closure.yes : words.closure.no}</span>
              </label>
            ))}
            <FieldError id="wantClose" problems={problems} words={words} />
          </fieldset>
        ) : null}

        {showFields ? (
          <>
            <Section title={words.form.aboutYou}>
              <TextField id="name" label={words.form.name.label} help={words.form.name.help} value={values.name} onChange={(v) => set("name", v)} problems={problems} words={words} autoComplete="name" maxLength={120} />
              {link?.maskedPhone ? (
                // the number comes from the chat: shown masked so the parent recognises it, and not editable
                <div>
                  <p className="mb-1 text-sm font-medium">{lw.phone.label}</p>
                  <p className="flex min-h-12 items-center gap-2 rounded-lg border border-input bg-muted px-3 font-mono text-base" data-masked-phone>
                    <ShieldCheck className="size-4 shrink-0 text-emerald-600" aria-hidden />
                    {link.maskedPhone}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{lw.phone.help}</p>
                </div>
              ) : (
                <TextField id="phone" label={words.form.phone.label} help={words.form.phone.help} value={values.phone} onChange={(v) => set("phone", v)} problems={problems} words={words} type="tel" inputMode="tel" autoComplete="tel" maxLength={20} />
              )}
              {link ? (
                <TextField id="email" label={lw.email.label} help={lw.email.help} value={typedEmail} onChange={setTypedEmail} problems={problems} words={words} type="email" inputMode="email" autoComplete="email" maxLength={254} />
              ) : email ? (
                <div>
                  <p className="mb-1 text-sm font-medium">{words.form.email.label}</p>
                  <p className="flex min-h-12 items-center gap-2 rounded-lg border border-input bg-muted px-3 text-base"><ShieldCheck className="size-4 shrink-0 text-emerald-600" aria-hidden />{maskEmail(email)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{words.form.email.help}</p>
                </div>
              ) : (
                // a refresh lost the address the browser kept: it is typed again (the server compares it to the one that was confirmed)
                <TextField id="email" label={words.form.email.label} help={words.form.email.help} value={typedEmail} onChange={setTypedEmail} problems={problems} words={words} type="email" inputMode="email" autoComplete="email" maxLength={254} />
              )}
              {closure ? (
                <>
                  <CheckField id="childrenFinished" label={words.closure.childrenFinished} checked={values.childrenFinished} onChange={(v) => set("childrenFinished", v)} problems={problems} words={words} />
                  <CheckField id="allowancesStopped" label={words.closure.allowancesStopped} checked={values.allowancesStopped} onChange={(v) => set("allowancesStopped", v)} problems={problems} words={words} />
                  <TextField id="reason" label={words.closure.reason} value={values.reason} onChange={(v) => set("reason", v)} problems={problems} words={words} multiline maxLength={1000} />
                </>
              ) : (
                <>
                  <TextField id="amount" label={words.withdrawal.amount} help={fillWords(words.withdrawal.amountHelp, { max: view.maxAmount.toLocaleString("en-MY", { maximumFractionDigits: 2 }) })} value={values.amount} onChange={(v) => set("amount", v)} problems={problems} words={words} inputMode="decimal" maxLength={14} />
                  <fieldset className="space-y-2">
                    <legend className="mb-1 text-sm font-medium">{words.withdrawal.reasonKind}</legend>
                    {(["over_topup", "other"] as const).map((v) => (
                      <label key={v} className={cn("flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2", values.reasonKind === v ? "border-primary bg-primary/5" : "border-border")}>
                        <input type="radio" name="reasonKind" value={v} data-field={v === "over_topup" ? "reasonKind" : undefined} checked={values.reasonKind === v} onChange={() => set("reasonKind", v)} className="size-5 accent-[var(--primary)]" />
                        <span>{v === "over_topup" ? words.withdrawal.overTopup : words.withdrawal.other}</span>
                      </label>
                    ))}
                    <FieldError id="reasonKind" problems={problems} words={words} />
                  </fieldset>
                  <TextField id="reasonText" label={values.reasonKind === "other" ? words.withdrawal.reasonTextOther : words.withdrawal.reasonTextMore} value={values.reasonText} onChange={(v) => set("reasonText", v)} problems={problems} words={words} multiline maxLength={1000} />
                  <TextField id="transactionRefs" label={words.withdrawal.transactionRefs} help={words.withdrawal.transactionRefsHelp} value={values.transactionRefs} onChange={(v) => set("transactionRefs", v)} problems={problems} words={words} multiline maxLength={1000} />
                  <FileField id="proof" label={words.withdrawal.proof} words={words} file={files.proof ?? null} onFile={(f) => setFiles((s) => ({ ...s, proof: f }))} problems={problems} />
                </>
              )}
            </Section>

            <Section title={words.form.bank.title} intro={words.form.bank.intro}>
              <fieldset className="space-y-2" role="radiogroup" aria-required="true" aria-invalid={!!problems.bankOwn} aria-describedby="cmp-bankOwn-err" data-bank-own>
                <legend className="mb-1 text-sm font-medium">{words.form.bank.own.question}</legend>
                {(["yes", "no"] as const).map((v) => (
                  <label key={v} className={cn("flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2", values.bankOwn === v ? "border-primary bg-primary/5" : "border-border")}>
                    <input
                      type="radio"
                      name="bankOwn"
                      value={v}
                      data-field={v === "yes" ? "bankOwn" : undefined}
                      checked={values.bankOwn === v}
                      onChange={() => {
                        set("bankOwn", v);
                        // a letter picked while the answer was No is dropped when it becomes Yes: it is neither shown nor sent
                        if (v === "yes") setFiles((s) => ({ ...s, letter: null }));
                      }}
                      className="size-5 accent-[var(--primary)]"
                    />
                    <span>{v === "yes" ? words.form.bank.own.yes : words.form.bank.own.no}</span>
                  </label>
                ))}
                <FieldError id="bankOwn" problems={problems} words={words} />
              </fieldset>
              <div>
                <label htmlFor="cmp-bankChoice" className="mb-1 block text-sm font-medium">{words.form.bank.choice}</label>
                <select id="cmp-bankChoice" data-field="bankChoice" className={SELECT} value={values.bankChoice} onChange={(e) => set("bankChoice", e.target.value)} aria-invalid={!!problems.bankChoice} aria-describedby="cmp-bankChoice-err">
                  <option value="">{words.form.bank.choose}</option>
                  {view.banks.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                  <option value={OTHER_BANK}>{words.form.bank.other}</option>
                </select>
                <FieldError id="bankChoice" problems={problems} words={words} />
              </div>
              {isOtherBank(values.bankChoice) ? <TextField id="bankOther" label={words.form.bank.otherName} value={values.bankOther} onChange={(v) => set("bankOther", v)} problems={problems} words={words} maxLength={80} /> : null}
              <TextField id="accountNumber" label={words.form.bank.number} help={words.form.bank.numberHelp} value={values.accountNumber} onChange={(v) => set("accountNumber", v)} problems={problems} words={words} inputMode="numeric" autoComplete="off" maxLength={30} />
              <TextField id="accountHolder" label={holderLabel(words, values)} help={words.form.bank.holderHelp} value={values.accountHolder} onChange={(v) => set("accountHolder", v)} problems={problems} words={words} autoComplete="off" maxLength={120} />
              {needLetter ? (
                <div className="space-y-2 rounded-xl border border-border p-3">
                  <p className="text-sm font-medium">{words.form.letter.title}</p>
                  <p className="text-sm text-muted-foreground">{words.form.letter.why}</p>
                  <FileField id="letter" label={words.form.letter.title} words={words} file={files.letter ?? null} onFile={(f) => setFiles((s) => ({ ...s, letter: f }))} problems={problems} hideLabel />
                </div>
              ) : null}
            </Section>

            <Section title={words.form.declaration.title}>
              <CheckField id="declaration" label={words.form.declaration.text} checked={values.declaration} onChange={(v) => set("declaration", v)} problems={problems} words={words} />
            </Section>

            <HoneyField />
            {banner ? <ErrorLine text={banner} /> : null}
            <Button type="submit" className="h-12 w-full text-base" disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {busy ? words.form.submitting : words.form.submit}
            </Button>
          </>
        ) : null}
      </form>
    </section>
  );
}

// ---- step 3: done -----------------------------------------------------------------------------------------------------

function DoneStep({ view, words, email, reference }: { view: PublicView; words: PublicWords; email: string; reference: string | null }) {
  const closure = view.type === "closure";
  const days = view.targetDays;
  const next2 = closure && days ? fillWords(words.done.next2Target, { days }) : words.done.next2;
  return (
    <section className="space-y-5" aria-labelledby="cmp-done-title">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-1 size-7 shrink-0 text-emerald-600" aria-hidden />
        <div>
          <h1 id="cmp-done-title" className="text-xl font-semibold leading-snug">{words.done.title}</h1>
          {email ? <p className="mt-1 text-sm text-muted-foreground">{fillWords(words.done.emailed, { email: maskEmail(email) })}</p> : null}
        </div>
      </div>
      <div className="rounded-xl border border-border p-4" role="status">
        {reference ? (
          <>
            <p className="text-sm text-muted-foreground">{words.done.reference}</p>
            <p className="font-mono text-2xl font-semibold tracking-wide" data-reference>{reference}</p>
          </>
        ) : (
          <p>{words.done.referenceByEmail}</p>
        )}
      </div>
      <div>
        <h2 className="mb-2 text-base font-semibold">{words.done.nextTitle}</h2>
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>{words.done.next1}</li>
          <li>{next2}</li>
          <li>{words.done.next3}</li>
        </ol>
      </div>
      <p className="flex items-start gap-2 rounded-lg bg-muted p-3 text-sm"><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />{words.done.safety}</p>
    </section>
  );
}

// ---- the small pieces -------------------------------------------------------------------------------------------------

function NoticeBlock({ view, locale }: { view: PublicView; locale: CustomerLocale }) {
  const text = view.notice[locale] || view.notice.en;
  if (!text) return null;
  return (
    <div className="rounded-xl border border-border bg-card p-3 text-sm whitespace-pre-wrap" role="note">
      {text}
    </div>
  );
}

function Section({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {intro ? <p className="text-sm text-muted-foreground">{intro}</p> : null}
      </div>
      {children}
    </section>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      {text}
    </p>
  );
}

function FieldError({ id, problems, words }: { id: PublicFieldId; problems: PublicProblems; words: PublicWords }) {
  const p = problems[id];
  return (
    <p id={`cmp-${id}-err`} role={p ? "alert" : undefined} className={cn("mt-1 text-sm text-destructive", !p && "hidden")}>
      {p ? problemText(words, p, id) : null}
    </p>
  );
}

function TextField({
  id,
  label,
  help,
  value,
  onChange,
  problems,
  words,
  multiline,
  type = "text",
  inputMode,
  autoComplete,
  maxLength,
}: {
  id: PublicFieldId;
  label: string;
  help?: string;
  value: string;
  onChange: (v: string) => void;
  problems: PublicProblems;
  words: PublicWords;
  multiline?: boolean;
  type?: string;
  inputMode?: "text" | "tel" | "email" | "numeric" | "decimal";
  autoComplete?: string;
  maxLength?: number;
}) {
  const invalid = !!problems[id];
  const describedBy = [help ? `cmp-${id}-help` : null, `cmp-${id}-err`].filter(Boolean).join(" ");
  return (
    <div>
      <label htmlFor={`cmp-${id}`} className="mb-1 block text-sm font-medium">{label}</label>
      {multiline ? (
        <Textarea id={`cmp-${id}`} data-field={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} maxLength={maxLength} aria-invalid={invalid} aria-describedby={describedBy} className="text-base" />
      ) : (
        <Input id={`cmp-${id}`} data-field={id} type={type} inputMode={inputMode} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} maxLength={maxLength} aria-invalid={invalid} aria-describedby={describedBy} className="h-12 text-base" />
      )}
      {help ? <p id={`cmp-${id}-help`} className="mt-1 text-xs text-muted-foreground">{help}</p> : null}
      <FieldError id={id} problems={problems} words={words} />
    </div>
  );
}

function CheckField({ id, label, checked, onChange, problems, words }: { id: PublicFieldId; label: string; checked: boolean; onChange: (v: boolean) => void; problems: PublicProblems; words: PublicWords }) {
  return (
    <div>
      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3">
        <input id={`cmp-${id}`} data-field={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className={TICK} aria-invalid={!!problems[id]} aria-describedby={`cmp-${id}-err`} />
        <span className="text-base leading-snug">{label}</span>
      </label>
      <FieldError id={id} problems={problems} words={words} />
    </div>
  );
}

function FileField({ id, label, words, file, onFile, problems, hideLabel }: { id: "letter" | "proof"; label: string; words: PublicWords; file: { name: string; size: number } | null; onFile: (f: { name: string; size: number; file: File } | null) => void; problems: PublicProblems; hideLabel?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div>
      {hideLabel ? null : <p className="mb-1 text-sm font-medium">{label}</p>}
      <input
        ref={input}
        id={`cmp-${id}`}
        data-field={id}
        type="file"
        accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
        className="sr-only"
        aria-label={label}
        aria-describedby={`cmp-${id}-help cmp-${id}-err`}
        onChange={(e) => {
          const f = e.target.files?.[0];
          onFile(f ? { name: f.name, size: f.size, file: f } : null);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" className="h-12 px-4 text-base" onClick={() => input.current?.click()}>
          {words.form.letter.choose}
        </Button>
        <span className="min-w-0 truncate text-sm text-muted-foreground">{file ? file.name : words.form.letter.none}</span>
        {file ? (
          <Button
            type="button"
            variant="ghost"
            className="h-11"
            onClick={() => {
              if (input.current) input.current.value = "";
              onFile(null);
            }}
          >
            {words.form.letter.remove}
          </Button>
        ) : null}
      </div>
      <p id={`cmp-${id}-help`} className="mt-1 text-xs text-muted-foreground">{words.form.letter.help}</p>
      <FieldError id={id} problems={problems} words={words} />
    </div>
  );
}

/** The hidden field a script fills and a person never sees (not reachable by keyboard, hidden from readers). */
function HoneyField() {
  return (
    <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
      <label>
        Website
        <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
      </label>
    </div>
  );
}

export { ALL_PUBLIC_WORDS };
