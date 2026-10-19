"use client";

// ============================================================
// KYC review, the decision: Approve or Reject one ID check. Everything arrives as props (the call itself is `decide`), so it renders the same in the app
// and in the render tests.
//
//   * A rejection needs a note (the parent is e-mailed by the back end); an approval may have one.
//   * Both ask first, in a dialog that says what will happen. Nothing is sent before the person confirms.
//   * While the call is out, everything is disabled: one click, one request.
//   * A check that already carries a review shows that review instead of the buttons.
//   * When the call fails in a way that leaves it unclear whether the back end took the decision (no answer, an unreadable answer), the screen is told
//     to reload the check (`onUncertain`), and the person is told to look at its status before trying again.
// ============================================================

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { DECISION_NOTE_MAX, type KycDecision, type KycDecisionResult, type KycValidation } from "@/lib/kyc/types";

import type { ApiResult } from "./api";
import { exactTime } from "./helpers";
import { ErrorPanel, ReviewChip } from "./parts";

/** After these the back end may or may not have taken the decision: the check is reloaded so its real status shows. */
export const UNCERTAIN_CODES = ["upstream_unreachable", "bad_response", "network", "already_decided"] as const;

export function DecisionPanel({
  v,
  canDecide,
  friendId,
  isAdmin,
  decide,
  onDone,
  onUncertain,
}: {
  v: KycValidation;
  canDecide: boolean;
  /** The friend id the decision is sent for: the check's own, else the one searched for; "" when there is none. */
  friendId: string;
  isAdmin: boolean;
  decide: (decision: KycDecision, note: string) => Promise<ApiResult<KycDecisionResult>>;
  onDone: (validationId: string, result: KycDecisionResult) => void;
  onUncertain: () => void;
}) {
  const t = useTranslations("Kyc.decision");
  const locale = useLocale();
  const [note, setNote] = useState("");
  const [noteInvalid, setNoteInvalid] = useState(false);
  const [asking, setAsking] = useState<KycDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [done, setDone] = useState<KycDecisionResult | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  if (!v.review && !canDecide) return null;

  const clean = note.replace(/\s+/g, " ").trim();
  const decidable = v.idUsable && friendId !== "";

  const ask = (decision: KycDecision) => {
    if (decision === "reject" && clean === "") {
      setNoteInvalid(true);
      noteRef.current?.focus();
      return;
    }
    setErrorCode(null);
    setAsking(decision);
  };

  const confirm = async () => {
    if (!asking || busy) return;
    setBusy(true);
    const res = await decide(asking, clean);
    setBusy(false);
    setAsking(null);
    if (res.ok) {
      setDone(res.data);
      onDone(v.id, res.data);
      return;
    }
    setErrorCode(res.code);
    if ((UNCERTAIN_CODES as readonly string[]).includes(res.code)) onUncertain();
  };

  return (
    <section aria-labelledby="kyc-decision-title" className="rounded-xl border border-border bg-card p-4">
      <h3 id="kyc-decision-title" className="font-medium text-foreground">
        {t("title")}
      </h3>

      {done ? <DoneNotice result={done} /> : null}

      {v.review ? (
        <div className="mt-2 space-y-1.5 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <ReviewChip review={v.review} />
            {v.review.at ? <time dateTime={v.review.at}>{exactTime(v.review.at, locale)}</time> : null}
          </p>
          {v.review.note ? (
            <p className="text-foreground">
              <span className="text-muted-foreground">{t("noteShown")}: </span>
              <span className="break-words">{v.review.note}</span>
            </p>
          ) : null}
        </div>
      ) : !decidable ? (
        <p className="mt-2 text-sm text-muted-foreground">{t("cannot")}</p>
      ) : (
        <>
          <p className="mt-1 text-xs text-muted-foreground">{t("intro")}</p>
          <label htmlFor="kyc-decision-note" className="mt-3 mb-1 block text-sm font-medium text-foreground">
            {t("noteLabel")}
          </label>
          <Textarea
            id="kyc-decision-note"
            ref={noteRef}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              if (noteInvalid) setNoteInvalid(false);
            }}
            placeholder={t("notePlaceholder")}
            rows={3}
            maxLength={DECISION_NOTE_MAX}
            disabled={busy}
            aria-invalid={noteInvalid || undefined}
            aria-describedby="kyc-decision-note-help"
          />
          <p id="kyc-decision-note-help" role={noteInvalid ? "alert" : undefined} className={noteInvalid ? "mt-1 text-xs text-destructive" : "mt-1 text-xs text-muted-foreground"}>
            {noteInvalid ? t("noteRequired") : t("noteHint", { count: note.length, max: DECISION_NOTE_MAX })}
          </p>

          {errorCode ? (
            <div className="mt-3 space-y-2">
              <ErrorPanel code={errorCode} isAdmin={isAdmin} compact />
              {(UNCERTAIN_CODES as readonly string[]).includes(errorCode) ? <p className="text-xs text-muted-foreground">{t("uncertain")}</p> : null}
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" onClick={() => ask("approve")} disabled={busy}>
              <CheckCircle2 aria-hidden />
              {t("approve")}
            </Button>
            <Button type="button" variant="destructive" onClick={() => ask("reject")} disabled={busy}>
              <XCircle aria-hidden />
              {t("reject")}
            </Button>
          </div>
        </>
      )}

      <Dialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setAsking(null);
        }}
      >
        <DialogContent className="bg-popover text-popover-foreground sm:max-w-sm" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>{asking === "reject" ? t("confirmRejectTitle") : t("confirmApproveTitle")}</DialogTitle>
            <DialogDescription>{asking === "reject" ? t("confirmRejectBody") : t("confirmApproveBody")}</DialogDescription>
          </DialogHeader>
          {clean ? (
            <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
              <span className="text-muted-foreground">{t("noteShown")}: </span>
              <span className="break-words">{clean}</span>
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAsking(null)} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button type="button" variant={asking === "reject" ? "destructive" : "default"} onClick={() => void confirm()} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {busy ? t("sending") : asking === "reject" ? t("confirmReject") : t("confirmApprove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** What happened, in words, including the two things the back end can report as half done. */
export function DoneNotice({ result }: { result: KycDecisionResult }) {
  const t = useTranslations("Kyc.decision");
  const message =
    result.decision === "approve" ? t("doneApproved") : result.emailSent === true ? t("doneRejectedEmailed") : result.emailSent === false ? t("doneRejectedNoEmail") : t("doneRejectedEmailUnknown");
  const warn = result.partial || (result.decision === "reject" && result.emailSent === false);
  return (
    <div role="status" className="mt-2 space-y-1 text-sm">
      <p className={warn ? "font-medium text-[light-dark(#b45309,#fcd34d)]" : "font-medium text-foreground"}>{message}</p>
      {result.partial ? <p className="text-[light-dark(#b45309,#fcd34d)]">{t("partial")}</p> : null}
    </div>
  );
}
