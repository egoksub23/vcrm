"use client";

// ============================================================
// Doc Sign, signing page: the page's state and what it can do. It holds the view the server gave, what
// the person has entered, and what is being saved, and gives each action (send a code, check it, agree,
// finish, decline) back as a function that answers `{ ok }`. A failure that changes what the page is
// (the link is gone, the code's session ended, the document closed meanwhile) is handled here, by asking
// the server for the page again; the screen then shows what is true now.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";

import { SignApiError } from "@/lib/sign/client/api";
import { completeSigning, declineSigning, fetchView, giveConsent, isOfflineFailure, isRetryableFailure, requestCode, saveAnswers, verifyCode } from "@/lib/sign/client/signer-api";
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
import type { PlacedField } from "@/lib/sign/pdf/types";
import type { AnswerInput } from "@/lib/sign/rules";
import type { SigningView } from "@/lib/sign/service/signing";

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; error: unknown; /** The page changed because of it, so there is nothing to say about the error. */ handled: boolean };

interface UseSignerArgs {
  token: string;
  initialView: SigningView;
  initialSessionOk: boolean;
  locale: string;
}

export function useSigner({ token, initialView, initialSessionOk, locale }: UseSignerArgs) {
  const [view, setView] = useState<SigningView>(initialView);
  const [sessionOk, setSessionOk] = useState(initialSessionOk);
  const [gone, setGone] = useState(false);
  const [answers, setAnswers] = useState<Answers>(() => (initialView.content ? answersFromStored(initialView.content.answers) : {}));
  const [rejected, setRejected] = useState<Rejections>({});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [notice, setNotice] = useState<"session_expired" | null>(null);

  // ---- the page itself -------------------------------------------------------------------------

  const applyView = useCallback((next: SigningView) => {
    setView(next);
    // what the server has fills in what was not entered here (another device, an earlier sitting); what is here is newer
    if (next.content) setAnswers((prev) => ({ ...answersFromStored(next.content?.answers ?? {}), ...prev }));
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
      new AutosaveQueue({
        send: (batch) => saveAnswers(token, batch),
        isRetryable: isRetryableFailure,
        isOffline: isOfflineFailure,
        onState: setSaveState,
        onRejected: (list) => setRejected((prev) => ({ ...prev, ...Object.fromEntries(list.map((r) => [r.field, r.code])) })),
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

  const finish = () =>
    run(async () => {
      const content = view.content;
      if (!content) throw new SignApiError("request_failed", "Nothing to finish.", 0);
      const { mine } = signerFields(content.fields, view.signer.roleKey);
      await queue.flush();
      const payload = completionPayload(mine, answers, (key, input) => queue.isSaved(key, input));
      try {
        await completeSigning(token, payload, locale);
      } catch (err) {
        if (err instanceof SignApiError && err.code === "invalid_answers") {
          setRejected((prev) => ({ ...prev, ...Object.fromEntries(err.issues.filter((i) => i.field && i.code !== "missing_required").map((i) => [i.field as string, i.code])) }));
        }
        throw err;
      }
      const next = await refresh();
      if (!next) setView((cur) => ({ ...cur, state: "signed", signer: { ...cur.signer, status: "signed" } }));
    });

  const decline = (reason: string) =>
    run(async () => {
      await declineSigning(token, reason);
      const next = await refresh();
      if (!next) setView((cur) => ({ ...cur, state: "declined", signer: { ...cur.signer, status: "declined" } }));
    });

  // ---- a document being sealed changes by itself -----------------------------------------------------

  const screen: Screen = screenFor(view);
  const polling = shouldPoll(screen) && !gone;
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

  return { view, screen, gone, sessionOk, answers, rejected, saveState, notice, setAnswer, refresh, sendCode, checkCode, consent, finish, decline, retrySave: () => queue.retryNow() };
}
