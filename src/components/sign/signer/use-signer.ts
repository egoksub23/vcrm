"use client";

// ============================================================
// Doc Sign, signing page: the page's state and what it can do. It holds the view the server gave, what
// the person has entered, and what is being saved, and gives each action (send a code, check it, agree,
// finish, decline) back as a function that answers `{ ok }`. A failure that changes what the page is
// (the link is gone, the code's session ended, the document closed meanwhile) is handled here, by asking
// the server for the page again; the screen then shows what is true now.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SignApiError } from "@/lib/sign/client/api";
import {
  completeSigning,
  declineSigning,
  fetchReview,
  fetchView,
  finishEnvelope,
  forwardTo,
  giveConsent,
  isOfflineFailure,
  isRetryableFailure,
  removeUpload,
  requestCode,
  saveAnswers,
  takeBackPart,
  uploadFile,
  verifyCode,
  type ForwardResponse,
  type SavedInput,
} from "@/lib/sign/client/signer-api";
import {
  AutosaveQueue,
  answersFromStored,
  completionPayload,
  evaluateAnswer,
  pollDelayMs,
  screenFor,
  shouldPoll,
  signerFields,
  type Answers,
  type Rejections,
  type SaveState,
  type Screen,
} from "@/lib/sign/client/signer-flow";
import {
  checkFormInput,
  formStateFromView,
  formViewOf,
  mapFormIssues,
  mergeFormView,
  visibleRejections,
  withAnswer,
  withConfirmed,
  withSaved,
  withUpload,
  withoutUpload,
  type FormRejections,
  type FormState,
} from "@/lib/sign/client/signer-form";
import type { FitProblem } from "@/lib/sign/forms/api-types";
import type { DataAnswerInput, FormDefinition, SignerFormView } from "@/lib/sign/forms/types";
import type { PlacedField } from "@/lib/sign/pdf/types";
import type { AnswerInput } from "@/lib/sign/rules";
import type { SigningView } from "@/lib/sign/service/signing";

/** How often a page waiting for a part it handed over asks whether it is done. */
const DELEGATE_POLL_MS = 20_000;

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; error: unknown; /** The page changed because of it, so there is nothing to say about the error. */ handled: boolean };

/** The answers as they will be printed on the form (the review step), or why they are not there. */
export type ReviewState = { status: "idle" } | { status: "loading" } | { status: "ready"; printed: Record<string, { text?: string; checked?: boolean }>; fitProblems: FitProblem[] } | { status: "error"; error: unknown };

/** A form this person fills in, as the page holds it; null when there is none or this person's role has no part. */
const initialFormState = (view: SigningView): FormState | null => (view.content?.form && view.content.form.partKeys.length > 0 ? formStateFromView(view.content.form) : null);

/** An envelope's sitting (migration 171): which document this page is on, how to move to another, and whether to check this one as soon as it opens. */
export interface EnvelopeSitting {
  documentId: string;
  /** Open another document of the envelope; `check` asks it to apply every rule at once and mark what is not ready (after a Finish that stopped there). */
  go: (documentId: string, opts?: { check?: boolean }) => void;
  checkOnMount?: boolean;
}

interface UseSignerArgs {
  /** The page's scope: the link's token, or `<token>@<document id>` for a document of an envelope (see lib/sign/client/scope.ts). */
  token: string;
  initialView: SigningView;
  initialSessionOk: boolean;
  locale: string;
  envelope?: EnvelopeSitting;
}

export function useSigner({ token, initialView, initialSessionOk, locale, envelope }: UseSignerArgs) {
  const [view, setView] = useState<SigningView>(initialView);
  const [sessionOk, setSessionOk] = useState(initialSessionOk);
  const [gone, setGone] = useState(false);
  const [answers, setAnswers] = useState<Answers>(() => (initialView.content ? answersFromStored(initialView.content.answers) : {}));
  const [rejected, setRejected] = useState<Rejections>({});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [notice, setNotice] = useState<"session_expired" | null>(null);
  /** The whole turn was handed to someone else: this link no longer works, and the page says so instead of asking again. */
  const [forwarded, setForwarded] = useState<{ to: string; delivered: boolean } | null>(null);

  // ---- forms in parts ------------------------------------------------------------------------------
  const [formState, setFormState] = useState<FormState | null>(() => initialFormState(initialView));
  const [formRejected, setFormRejected] = useState<FormRejections>({});
  const [formNotice, setFormNotice] = useState<"missing_required" | "invalid_answers" | "answer_does_not_fit" | null>(null);
  /** Where the form opens (a part, and a field in it); the number makes the same place openable again. */
  const [formStart, setFormStart] = useState<{ part?: string; field?: string; nonce: number }>({ nonce: 0 });
  const [stage, setStage] = useState<"form" | "review">("form");
  const [review, setReview] = useState<ReviewState>({ status: "idle" });
  const definitionRef = useRef<FormDefinition | null>(null);
  const definition = formState?.definition ?? null;
  useEffect(() => {
    definitionRef.current = definition;
  }, [definition]);

  // ---- the page itself -------------------------------------------------------------------------

  const applyView = useCallback((next: SigningView) => {
    setView(next);
    // what the server has fills in what was not entered here (another device, an earlier sitting); what is here is newer
    if (next.content) setAnswers((prev) => ({ ...answersFromStored(next.content?.answers ?? {}), ...prev }));
    const form = next.content?.form;
    if (form && form.partKeys.length > 0) setFormState((prev) => mergeFormView(prev, form));
    if (next.needsCode) setSessionOk(false);
  }, []);

  /** Ask the server for the page again. Null when it could not be reached. */
  const refresh = useCallback(async (): Promise<SigningView | null> => {
    try {
      const next = await fetchView(token);
      applyView(next);
      return next;
    } catch (err) {
      if (err instanceof SignApiError && err.code === "link_not_found") setGone(true);
      return null;
    }
  }, [token, applyView]);

  /** A failure that means the page is not what it was. True when it was one, and the page is being brought up to date. */
  const handleChange = useCallback(
    (err: unknown): boolean => {
      if (!(err instanceof SignApiError)) return false;
      switch (err.code) {
        case "link_not_found":
          setGone(true);
          return true;
        case "code_required":
          setSessionOk(false);
          setNotice("session_expired");
          void refresh();
          return true;
        case "signer_not_open":
        case "consent_required":
          void refresh();
          return true;
        default:
          return false;
      }
    },
    [refresh],
  );

  async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      return { ok: false, error: err, handled: handleChange(err) };
    }
  }

  // ---- saving as the person goes -----------------------------------------------------------------

  const failureRef = useRef<(err: unknown) => void>(() => {});
  useEffect(() => {
    failureRef.current = (err) => void handleChange(err);
  }, [handleChange]);

  const [queue] = useState(
    () =>
      new AutosaveQueue<SavedInput>({
        send: (batch, confirmParts = []) => saveAnswers(token, batch, confirmParts),
        isRetryable: isRetryableFailure,
        isOffline: isOfflineFailure,
        onState: setSaveState,
        onRejected: (list) => {
          // a data field of the form and a field on the page are told apart by the form's own list of keys
          const def = definitionRef.current;
          const dataKeys = new Set(def?.fields.map((f) => f.key) ?? []);
          const onPage = list.filter((r) => !dataKeys.has(r.field));
          if (onPage.length > 0) setRejected((prev) => ({ ...prev, ...Object.fromEntries(onPage.map((r) => [r.field, r.code])) }));
          if (def && list.length > onPage.length) setFormRejected((prev) => ({ ...prev, ...visibleRejections(list, def) }));
        },
        onSaved: (result) => {
          if (result.progress || result.ready !== undefined || result.unconfirmed) setFormState((prev) => (prev ? withSaved(prev, result) : prev));
        },
        onFailure: (err) => failureRef.current(err),
      }),
  );

  useEffect(() => {
    queue.revive();
    const online = () => queue.retryNow();
    const leaving = () => {
      if (document.visibilityState === "hidden") void queue.flush();
    };
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", leaving);
    window.addEventListener("pagehide", leaving);
    return () => {
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", leaving);
      window.removeEventListener("pagehide", leaving);
      queue.dispose();
    };
  }, [queue]);

  const setAnswer = useCallback(
    (field: PlacedField, input: AnswerInput) => {
      setAnswers((prev) => ({ ...prev, [field.key]: input }));
      setRejected((prev) => {
        if (!(field.key in prev)) return prev;
        const next = { ...prev };
        delete next[field.key];
        return next;
      });
      // a value that is not acceptable is marked on its field and not sent
      if (evaluateAnswer(field, input).status !== "invalid") queue.set(field.key, input);
    },
    [queue],
  );

  // ---- the form: answers, files, and the review step -------------------------------------------------------

  const clearFormRejection = useCallback((key: string) => {
    setFormRejected((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  /** A data field of the form changed. An answer that is acceptable is held and saved; one that is not stays marked on screen and is not sent. */
  const setFormAnswer = useCallback(
    (key: string, input: DataAnswerInput) => {
      const field = definition?.fields.find((f) => f.key === key);
      if (!field) return;
      clearFormRejection(key);
      setFormNotice(null);
      const checked = checkFormInput(field, input);
      if (!checked.ok) return;
      setFormState((prev) => (prev ? withAnswer(prev, key, checked.value) : prev));
      queue.set(key, input);
    },
    [definition, queue, clearFormRejection],
  );

  const uploadFormFile = useCallback(
    async (key: string, file: File, onProgress?: (fraction: number) => void) => {
      clearFormRejection(key);
      try {
        const result = await uploadFile(token, key, file, onProgress);
        setFormState((prev) => (prev ? withUpload(prev, key, result.file, result) : prev));
      } catch (err) {
        handleChange(err);
        throw err;
      }
    },
    [token, handleChange, clearFormRejection],
  );

  const removeFormFile = useCallback(
    async (key: string, fileId: string) => {
      try {
        const result = await removeUpload(token, key, fileId);
        setFormState((prev) => (prev ? withoutUpload(prev, key, fileId, result) : prev));
      } catch (err) {
        handleChange(err);
        throw err;
      }
    },
    [token, handleChange],
  );

  const confirmFormPart = useCallback(
    (partKey: string) => {
      setFormState((prev) => (prev ? withConfirmed(prev, partKey) : prev));
      queue.confirmPart(partKey);
    },
    [queue],
  );

  /** The answers as they will be printed. What the server has must be the latest, so what is waiting is sent first. */
  const openReview = useCallback(async () => {
    setStage("review");
    setFormNotice(null);
    setReview({ status: "loading" });
    if (!(await queue.flush())) {
      setReview({ status: "error", error: new SignApiError("network", "Not everything is saved yet.", 0) });
      return;
    }
    try {
      const result = await fetchReview(token);
      setReview({ status: "ready", printed: result.printed, fitProblems: result.fitProblems });
    } catch (err) {
      if (err instanceof SignApiError && err.code === "form_incomplete") {
        // the server does not think everything is answered: back to the parts, which are brought up to date
        setStage("form");
        setFormNotice("missing_required");
        void refresh();
        return;
      }
      if (!handleChange(err)) setReview({ status: "error", error: err });
    }
  }, [queue, token, handleChange, refresh]);

  /** Back to the parts, at the overview or, from a named answer, at the part (and field) it is in. */
  const openForm = useCallback((target?: { part: string; field?: string }) => {
    setStage("form");
    setFormStart((prev) => ({ ...target, nonce: prev.nonce + 1 }));
  }, []);

  /** The part and field each issue of a failed finish belongs to; true when the form has something to show. */
  function showFormIssues(err: SignApiError): void {
    if (!formState) return;
    // a person who only fills in has no review step: what is too long is marked on its field
    const filler = view.signer.kind === "filler";
    const targets = mapFormIssues(formState.definition, formState.partKeys, err.issues, filler);
    if (err.code === "answer_does_not_fit" && !filler) {
      if (targets.fit.length > 0) setReview((prev) => (prev.status === "ready" ? { ...prev, fitProblems: targets.fit } : prev));
      return;
    }
    if (Object.keys(targets.rejections).length === 0) return;
    setFormRejected((prev) => ({ ...prev, ...targets.rejections }));
    if (targets.firstPart) {
      setFormNotice(err.code === "invalid_answers" || err.code === "answer_does_not_fit" ? err.code : "missing_required");
      setFormStart((prev) => ({ part: targets.firstPart as string, field: targets.firstField ?? undefined, nonce: prev.nonce + 1 }));
      setStage("form");
    }
  }

  const form: SignerFormView | null = useMemo(() => (formState ? formViewOf(formState) : null), [formState]);
  // a person who only fills in goes straight from the parts to Submit; so does not a form without a signature, which has a review step of its own (migration 169)
  const formStage: "form" | "review" | "document" = formState ? (view.signer.kind === "filler" && view.document.mode !== "form" ? "form" : stage) : "document";

  // ---- what the person can do --------------------------------------------------------------------

  const sendCode = () => run(() => requestCode(token));

  const checkCode = (code: string) =>
    run(async () => {
      await verifyCode(token, code);
      setSessionOk(true);
      setNotice(null);
      // the code is used up: whatever the next request does, this screen is done
      setView((cur) => ({ ...cur, needsCode: false }));
      await refresh();
      queue.retryNow();
    });

  const consent = () =>
    run(async () => {
      await giveConsent(token, locale);
      setView((cur) => ({ ...cur, needsConsent: false }));
      await refresh();
    });

  /** What a failed finish (or check) says is wrong, marked on the fields it is about. */
  function markProblems(err: unknown): void {
    if (err instanceof SignApiError && (err.code === "missing_required" || err.code === "invalid_answers" || err.code === "answer_does_not_fit")) showFormIssues(err);
    if (err instanceof SignApiError && err.code === "invalid_answers") {
      const dataKeys = new Set(formState?.definition.fields.map((f) => f.key) ?? []);
      setRejected((prev) => ({ ...prev, ...Object.fromEntries(err.issues.filter((i) => i.field && !dataKeys.has(i.field) && i.code !== "missing_required").map((i) => [i.field as string, i.code])) }));
    }
  }

  // An envelope: the documents still to do, in order, and the one after this (null on the last: there the button finishes them all).
  const stillToDo = view.envelope ? view.envelope.documents.filter((d) => d.state === "active").map((d) => d.id) : [];
  const nextDocument = envelope ? (stillToDo[stillToDo.indexOf(envelope.documentId) + 1] ?? null) : null;

  const finish = () =>
    run(async () => {
      const content = view.content;
      if (!content) throw new SignApiError("request_failed", "Nothing to finish.", 0);
      const { mine } = signerFields(content.fields, view.signer.roleKey);
      await queue.flush();
      const payload = completionPayload(mine, answers, (key, input) => queue.isSaved(key, input));
      try {
        if (envelope) {
          // this document is only CHECKED (every rule applied, nothing changed); the person goes on to the next. On the last one every
          // document of theirs is completed, in order, by the server: nothing is final before that.
          await completeSigning(token, payload, locale, { check: true });
          if (nextDocument) {
            envelope.go(nextDocument);
            return;
          }
          await finishEnvelope(token, locale);
        } else {
          await completeSigning(token, payload, locale);
        }
      } catch (err) {
        markProblems(err);
        // finishing stopped at another document (the ones before it are signed): the page takes the person there, its problems marked
        const at = err instanceof SignApiError ? err.issues.find((i) => i.document)?.document : undefined;
        if (envelope && at && at !== envelope.documentId) {
          envelope.go(at, { check: true });
          return;
        }
        throw err;
      }
      const next = await refresh();
      if (!next) setView((cur) => ({ ...cur, state: "signed", signer: { ...cur.signer, status: "signed" } }));
    });

  // an envelope document opened because a Finish stopped there: apply every rule at once, so what is not ready is marked
  const checkedOnOpen = useRef(false);
  useEffect(() => {
    if (!envelope?.checkOnMount || checkedOnOpen.current || !view.content) return;
    checkedOnOpen.current = true;
    void (async () => {
      const { mine } = signerFields(view.content!.fields, view.signer.roleKey);
      await queue.flush();
      try {
        await completeSigning(token, completionPayload(mine, answers, (key, input) => queue.isSaved(key, input)), locale, { check: true });
      } catch (err) {
        markProblems(err);
        handleChange(err);
      }
    })();
    // once, when the document is open; the answers it checks are the ones now on the page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envelope?.checkOnMount, view.content]);

  /** Hand the whole turn (no `part`) or one part of the form to someone else. A part stays on this page, now waiting for them. */
  const forward = (input: { fullName: string; email: string; note?: string; part?: string }) =>
    run(async (): Promise<ForwardResponse> => {
      await queue.flush();
      const result = await forwardTo(token, input);
      if (input.part) await refresh();
      else setForwarded({ to: result.to, delivered: result.delivery.status === "sent" });
      return result;
    });

  /** Take a part back from the person it was handed to. */
  const takeBack = (part: string) =>
    run(async () => {
      await takeBackPart(token, part);
      await refresh();
    });

  const decline = (reason: string) =>
    run(async () => {
      await declineSigning(token, reason);
      const next = await refresh();
      if (!next) setView((cur) => ({ ...cur, state: "declined", signer: { ...cur.signer, status: "declined" } }));
    });

  // ---- a document being sealed changes by itself -----------------------------------------------------

  const screen: Screen = screenFor(view);
  // an envelope with a document being sealed changes by itself too (a document of the person's may be sealed while another still waits for somebody else)
  const polling = (shouldPoll(screen) || view.envelope?.state === "sealing" || !!view.envelope?.documents.some((d) => d.state === "sealing")) && !gone;
  useEffect(() => {
    if (!polling) return;
    const started = Date.now();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") await refresh();
      if (!stopped) timer = setTimeout(() => void tick(), pollDelayMs(Date.now() - started));
    };
    timer = setTimeout(() => void tick(), pollDelayMs(0));
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [polling, refresh]);

  // a part handed to someone else comes back by itself: ask again now and then, quietly, while the page is open and being waited on
  const waitingOnDelegate = screen === "fill" && !gone && !forwarded && (view.content?.delegations ?? []).some((d) => !d.done);
  useEffect(() => {
    if (!waitingOnDelegate) return;
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void refresh();
    }, DELEGATE_POLL_MS);
    return () => clearInterval(timer);
  }, [waitingOnDelegate, refresh]);

  return {
    view,
    screen,
    gone,
    sessionOk,
    answers,
    rejected,
    saveState,
    notice,
    setAnswer,
    refresh,
    sendCode,
    checkCode,
    consent,
    finish,
    decline,
    forwarded,
    forward,
    takeBack,
    retrySave: () => queue.retryNow(),
    // forms in parts
    form,
    formStage,
    formRejected,
    formNotice,
    formStart,
    review,
    setFormAnswer,
    uploadFormFile,
    removeFormFile,
    confirmFormPart,
    openReview,
    openForm,
    flush: () => void queue.flush(),
    // an envelope (migration 171)
    nextDocument,
  };
}
