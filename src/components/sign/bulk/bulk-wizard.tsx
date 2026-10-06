"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowLeft, Check, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { TemplatePicker } from "@/components/sign/send/template-picker";
import { Button } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-can";
import { useSignCategories } from "@/hooks/use-sign-categories";
import { useTemplateFacts } from "@/hooks/use-sign-bulk";
import { useActiveTemplates } from "@/hooks/use-sign-templates";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { EMPTY_FORM, WIZARD_STEPS, bulkErrorKey, buildRequest, pickDefaultRole, setupProblems, stepDone, type WizardForm, type WizardStep } from "@/lib/sign/client/bulk";
import type { BulkJobView, BulkPreview } from "@/lib/sign/bulk/types";
import { cn } from "@/lib/utils";
import { PeopleStep } from "./people-step";
import { RecentBatches } from "./recent-batches";
import { ReviewStep } from "./review-step";
import { SetupStep } from "./setup-step";

interface Props {
  templateId?: string | null;
}

/**
 * Bulk send: choose a template, upload a CSV or choose contacts, say which role they fill and who fills the others,
 * look at what would happen, and start. The documents are made and sent in the background, so the next screen is the
 * batch itself, which can be left open or closed.
 */
export function BulkWizard({ templateId: initialTemplate = null }: Props) {
  const t = useTranslations("Sign.bulk");
  const tNew = useTranslations("Sign.send.new");
  const router = useRouter();
  const canSend = useCapability("sign.send");
  const { live } = useSignCategories();
  const { templates, loading: templatesLoading, error: templatesError } = useActiveTemplates();

  const [form, setForm] = useState<WizardForm>({ ...EMPTY_FORM, templateId: initialTemplate });
  const [step, setStep] = useState<WizardStep>(initialTemplate ? "people" : "template");
  const [showInvalid, setShowInvalid] = useState(false);
  const { facts, loading: factsLoading, error: factsError } = useTemplateFacts(form.templateId);
  const roles = useMemo(() => facts?.roles ?? [], [facts]);
  const mergeKeys = useMemo(() => facts?.mergeKeys ?? [], [facts]);

  const patch = useCallback((p: Partial<WizardForm>) => setForm((f) => ({ ...f, ...p })), []);

  // a template just chosen: the role the people of the list most likely fill
  useEffect(() => {
    if (facts && form.personRole === null) setForm((f) => (f.personRole === null ? { ...f, personRole: pickDefaultRole(facts.roles) } : f));
  }, [facts, form.personRole]);

  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<{ code: string; detail?: string } | null>(null);
  const latest = useRef(0);

  const runPreview = useCallback(async () => {
    const body = buildRequest(form, roles);
    if (!body) return;
    const mine = ++latest.current;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const result = await signRequest<BulkPreview>("/api/sign/bulk/preview", { json: body });
      if (mine !== latest.current) return;
      setPreview(result);
    } catch (err) {
      if (mine !== latest.current) return;
      setPreview(null);
      setPreviewError(bulkErrorKey(err instanceof SignApiError ? err.code : "request_failed"));
    } finally {
      if (mine === latest.current) setPreviewing(false);
    }
  }, [form, roles]);

  // arriving at the last step checks the batch (what changed since is a click away: "Check again")
  useEffect(() => {
    if (step === "review") void runPreview();
    // only when the step is entered: later edits to the form do not re-run it by themselves
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const problems = setupProblems(form, roles);
  const done: Record<WizardStep, boolean> = {
    template: stepDone("template", form, roles),
    people: stepDone("people", form, roles),
    setup: stepDone("setup", form, roles),
    review: false,
  };
  const reachable = (s: WizardStep): boolean => WIZARD_STEPS.slice(0, WIZARD_STEPS.indexOf(s)).every((p) => done[p]);

  const goNext = () => {
    const i = WIZARD_STEPS.indexOf(step);
    if (step === "setup") {
      setShowInvalid(true);
      if (problems.length > 0 || factsLoading) return;
    }
    setStep(WIZARD_STEPS[Math.min(WIZARD_STEPS.length - 1, i + 1)]);
  };

  const start = async () => {
    const body = buildRequest(form, roles);
    if (!body || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const { job } = await signRequest<{ job: BulkJobView }>("/api/sign/bulk", { json: body });
      router.push(`/sign/bulk/${job.id}`);
    } catch (err) {
      const code = err instanceof SignApiError ? err.code : "request_failed";
      setCreateError({ code, detail: err instanceof SignApiError ? err.issues[0]?.detail : undefined });
      setCreating(false);
      // the list or the month's room may have changed: show it as it is now
      if (code === "rows_have_problems" || code === "sign_limit_reached" || code === "bulk_file_problems" || code === "bulk_not_ready") void runPreview();
    }
  };

  if (!canSend) {
    return (
      <div className="mx-auto mt-10 max-w-md rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground" role="status">
        <p className="mb-3">{t("noPermission")}</p>
        <Link href="/sign" className="text-primary underline-offset-4 hover:underline">
          {t("backToDocuments")}
        </Link>
      </div>
    );
  }

  // the setup step stays clickable: pressing Next there shows what is missing
  const nextDisabled = step !== "setup" && !done[step];
  const ready = !!preview && preview.counts.ok > 0 && preview.file.problems.length === 0 && preview.plan.problems.length === 0 && preview.headroom.fits && (preview.counts.withProblems === 0 || form.skipInvalid);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <Link href="/sign" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden />
          {t("backToDocuments")}
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-foreground">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <nav aria-label={t("steps.label")}>
        <ol className="flex items-center gap-1 overflow-x-auto">
          {WIZARD_STEPS.map((s, i) => {
            const current = s === step;
            const can = reachable(s);
            return (
              <li key={s} className="flex items-center gap-1">
                {i > 0 ? <span className="h-px w-3 bg-border sm:w-6" aria-hidden /> : null}
                <button
                  type="button"
                  disabled={!can || creating}
                  aria-current={current ? "step" : undefined}
                  onClick={() => setStep(s)}
                  className={cn(
                    "flex h-9 items-center gap-2 rounded-full px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                    current ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                      current ? "border-primary bg-primary text-primary-foreground" : done[s] ? "border-emerald-600 bg-emerald-500/15 text-emerald-700 dark:border-emerald-400 dark:text-emerald-300" : "border-border",
                    )}
                  >
                    {done[s] && !current ? <Check className="size-3" aria-hidden /> : i + 1}
                  </span>
                  <span className={cn(!current && "hidden sm:inline")}>{t(`steps.${s}`)}</span>
                  {done[s] ? <span className="sr-only">{t("steps.complete")}</span> : null}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {step === "template" ? (
        <section aria-labelledby="bulk-step-template" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
          <h2 id="bulk-step-template" className="text-sm font-semibold text-foreground">
            {t("template.heading")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("template.hint")}</p>
          <TemplatePicker templates={templates} loading={templatesLoading} error={templatesError} selectedId={form.templateId} onSelect={(tpl) => setForm((f) => (f.templateId === tpl.id ? f : { ...f, templateId: tpl.id, personRole: null, fixed: {} }))} />
          {factsError ? (
            <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="size-4" aria-hidden />
              {tNew("templatesFailed")}
            </p>
          ) : null}
        </section>
      ) : null}

      {step === "people" ? (
        <section aria-labelledby="bulk-step-people" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
          <h2 id="bulk-step-people" className="text-sm font-semibold text-foreground">
            {t("people.heading")}
          </h2>
          <PeopleStep form={form} mergeKeys={mergeKeys} onChange={patch} />
        </section>
      ) : null}

      {step === "setup" ? (
        factsLoading ? (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("setup.loading")}
          </div>
        ) : (
          <SetupStep form={form} roles={roles} categories={live} problems={problems} showInvalid={showInvalid} onChange={patch} />
        )
      ) : null}

      {step === "review" ? <ReviewStep preview={preview} loading={previewing} errorKey={previewError} skipInvalid={form.skipInvalid} onSkipInvalid={(v) => patch({ skipInvalid: v })} onRecheck={() => void runPreview()} /> : null}

      {createError ? (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{t(bulkErrorKey(createError.code), { detail: createError.detail ?? "" })}</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="ghost" disabled={step === "template" || creating} onClick={() => setStep(WIZARD_STEPS[Math.max(0, WIZARD_STEPS.indexOf(step) - 1)])}>
          {t("back")}
        </Button>
        {step === "review" ? (
          <Button type="button" size="lg" disabled={!ready || previewing || creating} onClick={() => void start()}>
            {creating ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t("review.start", { count: preview?.counts.ok ?? 0 })}
          </Button>
        ) : (
          <Button type="button" size="lg" disabled={nextDisabled} onClick={goNext}>
            {t("next")}
          </Button>
        )}
      </div>

      {step === "template" ? <RecentBatches /> : null}
    </div>
  );
}
