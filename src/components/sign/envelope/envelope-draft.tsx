"use client";

// ============================================================
// Doc Sign, an envelope that is still a draft (migration 171): the documents (each opens its own draft to place fields and fill in values), ONE
// signing list for all of them, the options they share, and a review that says what stands between it and Send, document by document. The people
// and the options save by themselves as they are edited. Send sends every document at once; the month's limit is checked for all of them first.
// ============================================================

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowLeft, CheckCircle2, ExternalLink, Loader2, Send, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCapability } from "@/hooks/use-can";
import { useNow } from "@/hooks/use-now";
import { combineSaveStates, useAutosave } from "@/hooks/use-sign-autosave";
import { useSignCategories, useSignSettings } from "@/hooks/use-sign-categories";
import type { EnvelopeData } from "@/hooks/use-sign-envelope";
import { SignApiError, signRequest, type SignIssue } from "@/lib/sign/client/api";
import { isEmptyPatch, optionsFlags } from "@/lib/sign/client/draft-options";
import { splitLayoutIssues } from "@/lib/sign/client/draft-problems";
import { dedupeEnvelopeIssues, envelopePatch, fixFor, groupByDocument, liveEnvelopeIssues, normalizePersonSteps, optionsFromEnvelope, peopleFromSigners, peopleKey, peoplePayload } from "@/lib/sign/client/envelope-form";
import { errorKey, problemKey, problemNamespace } from "@/lib/sign/client/errors";
import { resolveDefaults } from "@/lib/sign/defaults";
import { seedPeople, type EnvelopeDocLite, type EnvelopePerson } from "@/lib/sign/envelopes";
import { MAX_SIGNERS } from "@/lib/sign/rules";
import type { SignEnvelopeRow } from "@/lib/sign/types";

import { DocumentStatusBadge } from "../send/status-badge";
import { FormProblemText } from "../send/form-problem-text";
import { OptionsStep } from "../send/options-step";
import { SaveIndicator } from "../send/save-indicator";
import { SendResult, type SendResultData } from "../send/send-result";
import { EnvelopePeople } from "./envelope-people";

interface Props {
  envelopeId: string;
  data: EnvelopeData;
  reload: () => Promise<EnvelopeData | null>;
  /** Show the envelope as it is now (after it was sent, or when it turns out it was sent already). */
  onOpen: () => void;
}

interface SendResponse extends Omit<SendResultData, "documentId"> {
  envelopeId: string;
  documents: { id: string; title: string; reference: string | null; position: number }[];
}

const ENVELOPE_PROBLEM_CODES = new Set(["envelope_size", "envelope_too_many_pages", "duplicate_person", "person_without_document", "role_two_people"]);

export function EnvelopeDraft({ envelopeId, data, reload, onOpen }: Props) {
  const t = useTranslations("Sign.send.envelope");
  const tErr = useTranslations("Sign.send");
  const router = useRouter();
  const canSend = useCapability("sign.send");
  const now = useNow(60_000);
  const { live } = useSignCategories();
  const { settings, loading: settingsLoading } = useSignSettings();

  const env: SignEnvelopeRow = data.envelope;
  const docs: EnvelopeDocLite[] = data.documents.map((d) => ({ id: d.id, position: d.position, title: d.title, roles: d.roles, mode: d.mode, needed: d.rolesNeeded }));

  // What the screen starts from, read once; afterwards these are the sender's own edits.
  const [init] = useState(() => {
    const saved = peopleFromSigners(data.signers);
    const people = saved.length > 0 ? saved : seedPeople(docs);
    return { people, options: optionsFromEnvelope(env, data.links), peopleKey: peopleKey(peoplePayload(saved, docs, env.sign_in_order)) };
  });
  const [people, setPeople] = useState<EnvelopePerson[]>(init.people);
  const [options, setOptions] = useState(init.options);
  const [showInvalid, setShowInvalid] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendErrorCode, setSendErrorCode] = useState<string | null>(null);
  const [sendIssues, setSendIssues] = useState<SignIssue[]>([]);
  const [saveErrorCode, setSaveErrorCode] = useState<string | null>(null);
  const [result, setResult] = useState<SendResponse | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // The latest values, for the saves (which run later than the render that made them).
  const peopleRef = useRef(init.people);
  const optionsRef = useRef(init.options);
  const docsRef = useRef(docs);
  const savedPeopleKey = useRef(init.peopleKey);
  const savedOptions = useRef(init.options);
  const deleted = useRef(false);
  useEffect(() => {
    docsRef.current = docs;
  });

  const peopleSave = useAutosave(async () => {
    if (deleted.current) return;
    const payload = peoplePayload(peopleRef.current, docsRef.current, optionsRef.current.signInOrder);
    const key = peopleKey(payload);
    if (key === savedPeopleKey.current) return;
    try {
      await signRequest(`/api/sign/envelopes/${envelopeId}/signers`, { method: "PUT", json: { people: payload } });
      savedPeopleKey.current = key;
      setSaveErrorCode(null);
      void reload();
    } catch (err) {
      setSaveErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      throw err;
    }
  });

  const optionsSave = useAutosave(async () => {
    if (deleted.current) return;
    const patch = envelopePatch(savedOptions.current, optionsRef.current, new Date());
    if (isEmptyPatch(patch)) return;
    try {
      const res = await signRequest<{ envelope: SignEnvelopeRow }>(`/api/sign/envelopes/${envelopeId}`, { method: "PATCH", json: patch });
      savedOptions.current = optionsFromEnvelope(res.envelope, { ticketId: optionsRef.current.ticketId, dealId: optionsRef.current.dealId });
      setSaveErrorCode(null);
      void reload();
    } catch (err) {
      setSaveErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      throw err;
    }
  });

  const flushAll = async (): Promise<boolean> => (await Promise.all([peopleSave.flush(), optionsSave.flush()])).every(Boolean);

  const changePeople = (list: EnvelopePerson[]) => {
    peopleRef.current = list;
    setPeople(list);
    peopleSave.touch();
  };
  const changeOptions = (patch: Partial<typeof options>) => {
    const next = { ...optionsRef.current, ...patch };
    optionsRef.current = next;
    setOptions(next);
    optionsSave.touch();
    // the order numbers saved with the people depend on whether the envelope needs signing order
    if (patch.signInOrder !== undefined) changePeople(patch.signInOrder ? normalizePersonSteps(peopleRef.current) : peopleRef.current);
  };

  const defaults = resolveDefaults({ workspace: settings });
  const nowDate = new Date(now);
  const flags = optionsFlags(options, nowDate);
  const liveIssues = liveEnvelopeIssues(docs, people, options.signInOrder);
  const optionIssues: SignIssue[] = [...(flags.title ? [{ code: "title_required" }] : []), ...(flags.message ? [{ code: "message_long" }] : []), ...(flags.expiryPast ? [{ code: "expiry_past" }] : []), ...(flags.reminders ? [{ code: "reminders_bad" }] : [])];
  // the server's verdict is of what is saved; what is on screen may be ahead of it by a moment, so both are read and each problem shown once
  const problems = dedupeEnvelopeIssues([...optionIssues, ...liveIssues, ...data.problems, ...sendIssues]);
  const headroom = data.headroom;
  const blocked = problems.length > 0 || (headroom !== null && !headroom.fits);

  const send = async () => {
    if (sending) return;
    setSending(true);
    setSendErrorCode(null);
    setSendIssues([]);
    try {
      if (!(await flushAll())) {
        setSendErrorCode("save_failed");
        return;
      }
      setResult(await signRequest<SendResponse>(`/api/sign/envelopes/${envelopeId}/send`, { method: "POST" }));
    } catch (err) {
      setSendErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      if (err instanceof SignApiError) setSendIssues(err.issues);
      void reload();
    } finally {
      setSending(false);
    }
  };

  const deleteEnvelope = async () => {
    setDeleting(true);
    try {
      deleted.current = true;
      await signRequest(`/api/sign/envelopes/${envelopeId}`, { method: "DELETE" });
      toast.success(t("draft.deleted"));
      router.push("/sign");
    } catch (err) {
      deleted.current = false;
      setDeleting(false);
      setConfirmDelete(false);
      toast.error(tErr(errorKey(err instanceof SignApiError ? err.code : "request_failed")));
    }
  };

  if (result) {
    return (
      <SendResult
        result={{ documentId: envelopeId, reference: result.reference, expiresAt: result.expiresAt, invited: result.invited }}
        roles={[]}
        ordered={options.signInOrder}
        onOpenDocument={onOpen}
        words={{ title: t("sent.title"), subtitle: t("sent.subtitle", { count: result.documents.length }), open: t("sent.open") }}
      />
    );
  }

  const saveState = combineSaveStates([peopleSave.state, optionsSave.state]);
  const docTitle = (id: string | undefined | null) => data.documents.find((d) => d.id === id)?.title ?? "";
  const peopleCodes = (code: string) => ENVELOPE_PROBLEM_CODES.has(code);

  const problemText = (issue: SignIssue): string => {
    if (peopleCodes(issue.code)) return t(`problems.${issue.code}`, { n: issue.detail && /^\d+$/.test(issue.detail) ? Number(issue.detail) + 1 : 0, role: data.documents.find((d) => d.id === issue.document)?.roles.find((r) => r.key === issue.role)?.label ?? issue.role ?? "", document: docTitle(issue.document), range: issue.detail ?? "", max: MAX_SIGNERS });
    const n = issue.detail && /^\d+$/.test(issue.detail) ? Number(issue.detail) + 1 : 0;
    const role = data.documents.find((d) => d.id === issue.document)?.roles.find((r) => r.key === issue.role)?.label ?? issue.role ?? "";
    return tErr(problemKey(issue.code), { n, role, max: MAX_SIGNERS, count: 1 });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/sign" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" aria-hidden />
            {t("draft.back")}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-foreground">{options.title.trim() || env.title}</h1>
            <DocumentStatusBadge status="draft" />
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{t("badge", { count: docs.length })}</span>
            {env.reference ? <span className="text-xs text-muted-foreground">{env.reference}</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <SaveIndicator state={saveState} onRetry={() => void flushAll()} />
          {canSend ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 aria-hidden />
              {t("draft.delete")}
            </Button>
          ) : null}
        </div>
      </div>

      {saveErrorCode && saveState === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {tErr(errorKey(saveErrorCode))}
        </p>
      ) : null}
      {!canSend ? (
        <p role="status" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t("draft.readOnly")}
        </p>
      ) : null}

      <section aria-labelledby="env-docs" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div>
          <h2 id="env-docs" className="text-base font-semibold text-foreground">
            1. {t("documents.heading")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("documents.hint")}</p>
        </div>
        <ol className="space-y-2">
          {data.documents.map((d) => {
            const own = problems.filter((p) => p.document === d.id);
            return (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    <span className="text-muted-foreground tabular-nums">{d.position}.</span> {d.title}
                  </p>
                  <p className="text-xs text-muted-foreground">{[d.reference, d.mode === "form" ? t("documents.form") : t("documents.pages", { count: d.pageCount ?? 0 })].filter(Boolean).join(" · ")}</p>
                </div>
                <div className="flex items-center gap-2">
                  {own.length > 0 ? <span className="text-xs font-medium text-amber-700 dark:text-amber-300">{t("documents.problems", { count: own.length })}</span> : <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-label={t("documents.ready")} />}
                  <Link href={`/sign/${d.id}`} className="inline-flex h-7 items-center gap-1 rounded-lg border border-border px-2.5 text-[0.8rem] font-medium hover:bg-muted">
                    <ExternalLink className="size-3.5" aria-hidden />
                    {t("documents.edit")}
                  </Link>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section id="envelope-people" aria-labelledby="env-people" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="env-people" className="text-base font-semibold text-foreground">
          2. {t("people.heading")}
        </h2>
        <EnvelopePeople
          docs={docs}
          people={people}
          ordered={options.signInOrder}
          readOnly={!canSend}
          showInvalid={showInvalid}
          whatsappConfigured={settingsLoading ? null : !!settings?.whatsapp_template_name}
          onPeople={changePeople}
          onOrdered={(v) => changeOptions({ signInOrder: v })}
        />
      </section>

      <section id="envelope-options" aria-labelledby="env-options" className="space-y-3">
        <h2 id="env-options" className="text-base font-semibold text-foreground">
          3. {t("options.heading")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("options.hint")}</p>
        <OptionsStep envelope options={options} categories={live} defaultExpiryDays={defaults.expiryDays} now={now} showInvalid readOnly={!canSend} onChange={changeOptions} />
      </section>

      <section id="envelope-review" aria-labelledby="env-review" className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="env-review" className="text-base font-semibold text-foreground">
          4. {t("review.heading")}
        </h2>
        <p className="text-sm text-foreground">{options.signInOrder ? t("review.ordered") : t("review.allAtOnce")}</p>
        <p className="text-xs text-muted-foreground">{t("review.counts", { documents: docs.length, people: people.filter((p) => p.fullName.trim()).length })}</p>

        {headroom && !headroom.fits ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
            <p>{t("review.limit", { needed: headroom.needed, remaining: headroom.remaining ?? 0 })}</p>
          </div>
        ) : null}

        {problems.length > 0 ? (
          <div role="status" className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <AlertCircle className="size-4 text-amber-700 dark:text-amber-300" aria-hidden />
              {t("review.problemsTitle", { count: problems.length })}
            </h3>
            {groupByDocument(problems).map((g) => {
              const { single, layoutCount } = splitLayoutIssues(g.issues);
              const roleLabelOf = (issue: SignIssue) => data.documents.find((d) => d.id === issue.document)?.roles.find((r) => r.key === issue.role)?.label ?? issue.role ?? "";
              return (
                <div key={g.documentId ?? "envelope"} className="space-y-1">
                  <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.documentId ? docTitle(g.documentId) : t("review.sharedHeading")}</p>
                  <ul className="space-y-1.5">
                    {single.map((issue, i) => {
                      const fix = fixFor(issue);
                      return (
                        <li key={`${issue.code}-${issue.detail ?? ""}-${issue.role ?? ""}-${i}`} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span className="text-foreground">{!peopleCodes(issue.code) && problemNamespace(issue.code) === "Sign.progress" ? <FormProblemText issue={issue} roleLabel={roleLabelOf(issue)} /> : problemText(issue)}</span>
                          {fix.kind === "document" ? (
                            <Link href={`/sign/${fix.documentId}`} className="inline-flex h-6 items-center rounded-lg border border-border px-2 text-xs font-medium hover:bg-muted">
                              {t("review.fixDocument")}
                            </Link>
                          ) : (
                            <a href={fix.kind === "options" ? "#envelope-options" : "#envelope-people"} onClick={() => setShowInvalid(true)} className="inline-flex h-6 items-center rounded-lg border border-border px-2 text-xs font-medium hover:bg-muted">
                              {t(fix.kind === "options" ? "review.fixOptions" : "review.fixPeople")}
                            </a>
                          )}
                        </li>
                      );
                    })}
                    {layoutCount > 0 && g.documentId ? (
                      <li className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span className="text-foreground">{t("review.layout", { count: layoutCount })}</span>
                        <Link href={`/sign/${g.documentId}`} className="inline-flex h-6 items-center rounded-lg border border-border px-2 text-xs font-medium hover:bg-muted">
                          {t("review.fixDocument")}
                        </Link>
                      </li>
                    ) : null}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300" role="status">
            <CheckCircle2 className="size-4" aria-hidden />
            {t("review.ready")}
          </p>
        )}

        {sendErrorCode ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{tErr(errorKey(sendErrorCode))}</p>
          </div>
        ) : null}
        {sendErrorCode === "envelope_not_draft" ? (
          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={onOpen}>
              {t("review.openEnvelope")}
            </Button>
          </div>
        ) : null}

        <div className="flex flex-col items-end gap-1.5">
          <Button type="button" size="lg" disabled={!canSend || blocked || sending} onClick={() => void send()}>
            {sending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
            {t("review.send", { count: docs.length })}
          </Button>
          <p className="text-xs text-muted-foreground">{!canSend ? t("review.noPermission") : blocked ? t("review.sendBlocked") : t("review.sendNote")}</p>
        </div>
      </section>

      <Dialog open={confirmDelete} onOpenChange={(o) => (deleting ? undefined : setConfirmDelete(o))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("draft.deleteTitle")}</DialogTitle>
            <DialogDescription>{t("draft.deleteBody", { count: docs.length })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={deleting} onClick={() => setConfirmDelete(false)}>
              {t("draft.cancel")}
            </Button>
            <Button type="button" variant="destructive" disabled={deleting} onClick={() => void deleteEnvelope()}>
              {deleting ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
              {t("draft.deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
