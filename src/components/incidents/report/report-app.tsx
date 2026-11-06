"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Camera, Check, CheckCircle2, ChevronLeft, Loader2, Plus, WifiOff, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { labelOf } from "@/lib/incidents/platform/roles";
import type { Answers, FormField, InvolvedAnswer } from "@/lib/incidents/intake/form-schema";
import { visibleFields } from "@/lib/incidents/intake/form-schema";
import type { ReportView } from "@/lib/incidents/intake/service";
import {
  clearDraft,
  firstStepWithProblem,
  loadDraft,
  notifyParent,
  parentMessage,
  pickStorage,
  saveDraft,
  stepProblems,
  type DraftStorage,
} from "@/lib/incidents/intake/report-client";

type Open = Extract<ReportView, { state: "open" }>;
type Sent = { reference: string; told: string[]; returnUrl: string | null; duplicate: boolean };
type PhotoState = { name: string; status: "waiting" | "sending" | "done" | "failed" };

const emptyInvolved: InvolvedAnswer = { ids: [], others: [] };

/** A page that is not in a frame has no one to message; one that is posts only to the origins registered for the key. */
function useParentNotifier(origins: readonly string[]) {
  return useCallback(
    (message: ReturnType<(typeof parentMessage)[keyof typeof parentMessage]>) => {
      if (typeof window === "undefined") return;
      notifyParent(window, window, origins, message);
    },
    [origins],
  );
}

/** The state of a link that cannot be filled in: not valid, expired, or already sent. Tells the parent page, so the portal can react. */
export function ReportNotice({ kind, reference, returnUrl, origins }: { kind: "invalid" | "expired" | "submitted"; reference?: string; returnUrl?: string | null; origins: string[] }) {
  const t = useTranslations("IncidentPlatform.report");
  const notify = useParentNotifier(origins);
  useEffect(() => {
    notify(kind === "submitted" ? parentMessage.submitted(reference ?? "") : parentMessage.error(kind === "expired" ? "link_expired" : "invalid_link"));
  }, [kind, reference, notify]);
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-8">
      <h1 className="text-xl font-semibold">{t(`notice.${kind}.title`)}</h1>
      <p className="text-sm text-muted-foreground">{t(`notice.${kind}.body`, { reference: reference ?? "" })}</p>
      {kind === "submitted" && returnUrl ? <a href={returnUrl} className="text-sm font-medium text-primary underline">{t("backToPortal")}</a> : null}
    </main>
  );
}

export function ReportApp({ token, view, origins }: { token: string; view: Open; origins: string[] }) {
  const t = useTranslations("IncidentPlatform.report");
  const notify = useParentNotifier(origins);
  const { schema, roster } = view;

  const storage = useRef<DraftStorage | null>(null);
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [offline, setOffline] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [expired, setExpired] = useState(false);
  const [photos, setPhotos] = useState<File[]>([]);
  const [photoState, setPhotoState] = useState<PhotoState[]>([]);

  // Restore a draft once the page is in the browser (storage does not exist while it is rendered on the server).
  useEffect(() => {
    storage.current = pickStorage(() => window.localStorage);
    const draft = loadDraft(storage.current, token);
    if (draft) {
      setAnswers(draft.answers);
      setStep(Math.min(draft.step, schema.steps.length - 1));
      if (draft.pending) setOffline(true);
    }
    setReady(true);
    notify(parentMessage.ready());
  }, [token, schema.steps.length, notify]);

  // Keep the draft as the coach types. A weak connection must never cost them the report.
  useEffect(() => {
    if (!ready || sent || !storage.current) return;
    saveDraft(storage.current, token, { answers, step, pending: offline });
  }, [answers, step, offline, ready, sent, token]);

  // Tell the page that frames this one how tall it is, so it never needs a second scrollbar.
  useEffect(() => {
    const report = () => notify(parentMessage.resize(document.documentElement.scrollHeight));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [notify]);

  const setAnswer = (key: string, value: unknown) => {
    setAnswers((cur) => ({ ...cur, [key]: value }));
    setProblems((cur) => {
      if (!cur[key]) return cur;
      const { [key]: _gone, ...rest } = cur;
      void _gone;
      return rest;
    });
  };

  const current = schema.steps[step];
  const last = step === schema.steps.length - 1;

  const uploadPhotos = useCallback(
    async (files: File[]) => {
      setPhotoState(files.map((f) => ({ name: f.name, status: "waiting" })));
      for (const [i, file] of files.entries()) {
        setPhotoState((cur) => cur.map((p, j) => (j === i ? { ...p, status: "sending" } : p)));
        const body = new FormData();
        body.set("token", token);
        body.set("file", file);
        let ok = false;
        try {
          ok = (await fetch("/api/public/incident-report/photo", { method: "POST", body })).ok;
        } catch {
          ok = false;
        }
        setPhotoState((cur) => cur.map((p, j) => (j === i ? { ...p, status: ok ? "done" : "failed" } : p)));
      }
    },
    [token],
  );

  const send = useCallback(async () => {
    setSending(true);
    setFailure(null);
    let res: Response | null = null;
    try {
      res = await fetch("/api/public/incident-report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, answers }) });
    } catch {
      res = null;
    }
    setSending(false);

    if (!res) {
      // No connection: keep everything on the phone and send again when it returns.
      setOffline(true);
      return;
    }
    const json = (await res.json().catch(() => ({}))) as { reference?: string; told?: string[]; return_url?: string | null; duplicate?: boolean; error?: { code?: string; message?: string; fields?: Record<string, string> } };
    if (res.ok && json.reference) {
      setOffline(false);
      if (storage.current) clearDraft(storage.current, token);
      setSent({ reference: json.reference, told: json.told ?? [], returnUrl: json.return_url ?? view.returnUrl, duplicate: json.duplicate === true });
      notify(parentMessage.submitted(json.reference));
      if (photos.length > 0) void uploadPhotos(photos);
      return;
    }
    const code = json.error?.code;
    if (code === "invalid_answers" && json.error?.fields) {
      setProblems(json.error.fields);
      setStep(firstStepWithProblem(schema, json.error.fields));
      setOffline(false);
      return;
    }
    if (code === "link_expired") {
      setExpired(true);
      notify(parentMessage.error("link_expired"));
      return;
    }
    if (res.status === 404) {
      setExpired(true);
      notify(parentMessage.error("invalid_link"));
      return;
    }
    // Anything else (a busy server, too many tries): keep the draft and let the coach try again.
    setFailure(json.error?.message ?? t("sendFailed"));
  }, [token, answers, photos, schema, view.returnUrl, notify, uploadPhotos, t]);

  // While a report is waiting to go, try again when the phone says it is back online, and every 20 seconds.
  useEffect(() => {
    if (!offline || sending || sent) return;
    const retry = () => void send();
    window.addEventListener("online", retry);
    const timer = setInterval(() => navigator.onLine && retry(), 20_000);
    return () => {
      window.removeEventListener("online", retry);
      clearInterval(timer);
    };
  }, [offline, sending, sent, send]);

  if (expired) return <ReportNotice kind="expired" origins={origins} />;

  if (sent) {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-5 px-4 py-8">
        <CheckCircle2 className="size-10 text-emerald-500" aria-hidden />
        <div>
          <h1 className="text-xl font-semibold">{t("sent.title")}</h1>
          <p className="mt-1 font-mono text-lg">{sent.reference}</p>
          {view.mode === "test" ? <p className="mt-2 rounded-lg bg-amber-500/15 px-3 py-2 text-sm">{t("sent.testNote")}</p> : null}
        </div>
        <p className="text-sm">{sent.told.length ? t("sent.told", { roles: sent.told.join(", ") }) : t("sent.toldNobody")}</p>
        {photoState.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm" aria-live="polite">
            {photoState.map((p, i) => (
              <li key={i} className="flex items-center gap-2">
                {p.status === "done" ? <Check className="size-4 text-emerald-500" /> : p.status === "failed" ? <X className="size-4 text-red-500" /> : <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                <span className="truncate">{p.name}</span>
                {p.status === "failed" ? <span className="text-xs text-red-600 dark:text-red-400">{t("sent.photoFailed")}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {sent.returnUrl && window.parent === window ? <a href={sent.returnUrl} className="inline-flex h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground">{t("backToPortal")}</a> : null}
      </main>
    );
  }

  if (!ready) return <main className="mx-auto max-w-md px-4 py-8" aria-busy="true" />;

  const fields = visibleFields(current, answers);
  const next = () => {
    const found = stepProblems(schema, current, answers, roster);
    if (Object.keys(found).length > 0) return void setProblems(found);
    setProblems({});
    if (last) void send();
    else setStep(step + 1);
  };

  return (
    <main className="mx-auto flex max-w-md flex-col gap-5 px-4 pt-5 pb-28">
      {view.mode === "test" ? <p role="status" className="rounded-lg bg-amber-500/15 px-3 py-2 text-sm font-medium">{t("testBanner")}</p> : null}
      <header className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">
          {view.activity.name}
          {view.activity.date ? ` · ${view.activity.date}` : ""} · {view.coachName}
        </p>
        <div className="flex items-center gap-2">
          {step > 0 ? (
            <button type="button" onClick={() => setStep(step - 1)} aria-label={t("back")} className="-ml-2 flex size-9 items-center justify-center rounded-lg hover:bg-muted">
              <ChevronLeft className="size-5" />
            </button>
          ) : null}
          <h1 className="text-xl font-semibold">{labelOf(current.title)}</h1>
        </div>
        <p className="text-xs text-muted-foreground" aria-label={t("stepOf", { n: step + 1, total: schema.steps.length })}>
          {schema.steps.map((s, i) => (
            <span key={s.key} className={cn("mr-1 inline-block h-1.5 w-8 rounded-full", i <= step ? "bg-primary" : "bg-muted")} />
          ))}
        </p>
      </header>

      {fields.map((f) => (
        <FieldView key={f.key} field={f} answers={answers} problem={problems[f.key]} setAnswer={setAnswer} roster={roster} photos={photos} setPhotos={setPhotos} />
      ))}

      {offline ? (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <WifiOff className="mt-0.5 size-4 shrink-0" />
          {t("offline")}
        </p>
      ) : null}
      {failure ? <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm">{failure}</p> : null}

      <div className="fixed inset-x-0 bottom-0 border-t border-border bg-background/95 px-4 py-3 backdrop-blur" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        <div className="mx-auto max-w-md">
          <Button size="lg" className="h-12 w-full text-base" onClick={next} disabled={sending || offline}>
            {sending ? <Loader2 className="animate-spin" /> : null}
            {last ? (offline ? t("waitingToSend") : t("send")) : t("next")}
          </Button>
        </div>
      </div>
    </main>
  );
}

// ---- fields -----------------------------------------------------------------------------------------------------

function FieldView({
  field,
  answers,
  problem,
  setAnswer,
  roster,
  photos,
  setPhotos,
}: {
  field: FormField;
  answers: Answers;
  problem?: string;
  setAnswer: (key: string, value: unknown) => void;
  roster: Open["roster"];
  photos: File[];
  setPhotos: (files: File[]) => void;
}) {
  const t = useTranslations("IncidentPlatform.report");
  const v = answers[field.key];
  const id = `f-${field.key}`;

  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={problem ? `${id}-err` : undefined}>
      <legend className="text-sm font-medium">
        {labelOf(field.label)}
        {field.required ? <span className="text-red-500"> *</span> : null}
      </legend>
      {field.help ? <p className="-mt-1 text-xs text-muted-foreground">{labelOf(field.help)}</p> : null}

      {field.type === "involved" ? <InvolvedField value={(v as InvolvedAnswer) ?? emptyInvolved} roster={roster} onChange={(next) => setAnswer(field.key, next)} /> : null}

      {field.type === "choice" ? (
        <div role="radiogroup" className="flex flex-col gap-2">
          {(field.options ?? []).map((o) => {
            const on = v === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setAnswer(field.key, o.value)}
                className={cn("flex min-h-14 flex-col items-start justify-center rounded-xl border px-4 py-2 text-left", on ? "border-primary bg-primary/10" : "border-border hover:bg-muted")}
              >
                <span className="text-base font-medium">{labelOf(o.label)}</span>
                {o.help ? <span className="text-xs text-muted-foreground">{labelOf(o.help)}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {field.type === "yesno" ? (
        <div role="radiogroup" className="grid grid-cols-2 gap-2">
          {([true, false] as const).map((val) => (
            <button
              key={String(val)}
              type="button"
              role="radio"
              aria-checked={v === val}
              onClick={() => setAnswer(field.key, val)}
              className={cn("min-h-12 rounded-xl border px-4 text-base font-medium", v === val ? "border-primary bg-primary/10" : "border-border hover:bg-muted")}
            >
              {val ? t("yes") : t("no")}
            </button>
          ))}
        </div>
      ) : null}

      {field.type === "text" || field.type === "longtext" ? (
        <>
          {field.type === "longtext" ? (
            <textarea
              id={id}
              rows={4}
              maxLength={field.maxLength ?? 2000}
              value={typeof v === "string" ? v : ""}
              onChange={(e) => setAnswer(field.key, e.target.value)}
              className="w-full rounded-xl border border-input bg-background px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          ) : (
            <input
              id={id}
              maxLength={field.maxLength ?? 200}
              value={typeof v === "string" ? v : ""}
              onChange={(e) => setAnswer(field.key, e.target.value)}
              className="h-12 w-full rounded-xl border border-input bg-background px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          )}
        </>
      ) : null}

      {field.type === "photo" ? <PhotoField photos={photos} setPhotos={setPhotos} /> : null}

      {problem ? <p id={`${id}-err`} role="alert" className="text-sm text-red-600 dark:text-red-400">{problem}</p> : null}
    </fieldset>
  );
}

function InvolvedField({ value, roster, onChange }: { value: InvolvedAnswer; roster: Open["roster"]; onChange: (v: InvolvedAnswer) => void }) {
  const t = useTranslations("IncidentPlatform.report");
  const [typed, setTyped] = useState("");
  const toggle = (id: string) => onChange({ ...value, ids: value.ids.includes(id) ? value.ids.filter((x) => x !== id) : [...value.ids, id] });
  const addOther = () => {
    const name = typed.trim();
    if (!name) return;
    onChange({ ...value, others: [...value.others, name.slice(0, 80)] });
    setTyped("");
  };
  return (
    <div className="flex flex-col gap-2">
      {roster.length === 0 ? <p className="text-sm text-muted-foreground">{t("noRoster")}</p> : null}
      {roster.map((r) => {
        const on = value.ids.includes(r.student_id);
        return (
          <button
            key={r.student_id}
            type="button"
            role="checkbox"
            aria-checked={on}
            onClick={() => toggle(r.student_id)}
            className={cn("flex min-h-14 items-center gap-3 rounded-xl border px-4 py-2 text-left", on ? "border-primary bg-primary/10" : "border-border hover:bg-muted")}
          >
            <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md border", on ? "border-primary bg-primary text-primary-foreground" : "border-border")}>{on ? <Check className="size-4" /> : null}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-medium">{r.name}</span>
              {r.class ? <span className="block text-xs text-muted-foreground">{r.class}</span> : null}
            </span>
          </button>
        );
      })}
      {value.others.map((name, i) => (
        <div key={`${name}-${i}`} className="flex items-center gap-3 rounded-xl border border-primary bg-primary/10 px-4 py-3">
          <span className="min-w-0 flex-1 truncate text-base font-medium">{name}</span>
          <button type="button" aria-label={t("removeOther", { name })} onClick={() => onChange({ ...value, others: value.others.filter((_, j) => j !== i) })} className="flex size-8 items-center justify-center rounded-lg hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addOther();
            }
          }}
          placeholder={t("someoneElse")}
          aria-label={t("someoneElse")}
          maxLength={80}
          className="h-12 min-w-0 flex-1 rounded-xl border border-input bg-background px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <Button type="button" variant="outline" size="lg" className="h-12" onClick={addOther} disabled={!typed.trim()} aria-label={t("addOther")}>
          <Plus />
        </Button>
      </div>
    </div>
  );
}

function PhotoField({ photos, setPhotos }: { photos: File[]; setPhotos: (files: File[]) => void }) {
  const t = useTranslations("IncidentPlatform.report");
  return (
    <div className="flex flex-col gap-2">
      {photos.map((f, i) => (
        <div key={`${f.name}-${i}`} className="flex items-center gap-3 rounded-xl border border-border px-4 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate">{f.name}</span>
          <button type="button" aria-label={t("removePhoto", { name: f.name })} onClick={() => setPhotos(photos.filter((_, j) => j !== i))} className="flex size-8 items-center justify-center rounded-lg hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>
      ))}
      {photos.length < 5 ? (
        // A plain file input: the phone offers the camera or the photo library, and a web view without camera access still gets the file picker.
        <label className="flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 text-sm font-medium hover:bg-muted">
          <Camera className="size-4" />
          {t("addPhoto")}
          <input
            type="file"
            accept="image/*,application/pdf"
            className="sr-only"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []).filter((f) => f.size > 0 && f.size <= 10 * 1024 * 1024);
              if (picked.length) setPhotos([...photos, ...picked].slice(0, 5));
              e.target.value = "";
            }}
          />
        </label>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("photoNote")}</p>
    </div>
  );
}
