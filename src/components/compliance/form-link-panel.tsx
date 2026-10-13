"use client";

// ============================================================
// Compliance requests, one case: the personal closure form link (migration 185). For an account closure it lists the links made for the case (newest first,
// each with its state: Not sent, Sent, Opened, Submitted, Expired, Withdrawn, Replaced) and lets a person who may act send a new one (the old one stops
// working) or withdraw the active one. The personal address is never shown here: a link that could not be put in the chat gives its address once, in the
// answer to Send again, for the person who just pressed it to copy.
// ============================================================

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { canRevoke, canSendAnother } from "@/lib/compliance/chat-link/link-state";
import type { ChatLinkOutcome, FormLinkView } from "@/lib/compliance/chat-link/types";

import { resendClosureForm, revokeClosureForm } from "./api";
import { ChatLinkResult, LinkStateChip } from "./chat-link-parts";
import type { PanelProps } from "./detail-panels";
import { errorKey, formatWhen } from "./helpers";
import { Notice, Panel, Person } from "./parts";

/** Which of a case's links can be acted on: the newest one decides (older ones were replaced, withdrawn or used). Pure, so it is tested. */
export function linkActions(links: readonly Pick<FormLinkView, "state">[], opts: { canAct: boolean; caseOpen: boolean }): { resend: boolean; revoke: boolean } {
  if (!opts.canAct || !opts.caseOpen) return { resend: false, revoke: false };
  const latest = links[0];
  if (!latest) return { resend: true, revoke: false };
  return { resend: canSendAnother(latest.state), revoke: canRevoke(latest.state) };
}

export function FormLinkPanel({ d, act, busy }: PanelProps) {
  const t = useTranslations("Compliance.chatLink.panel");
  const tErr = useTranslations("Compliance.errors");
  const locale = useLocale();
  const [outcome, setOutcome] = useState<ChatLinkOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  if (d.typeKey !== "closure") return null;
  const canAct = d.viewer.canReview || d.viewer.canApprove;
  const caseOpen = d.status === "received" || d.status === "identity_check" || d.status === "officer_review";
  const links = d.formLinks ?? [];
  const actions = linkActions(links, { canAct, caseOpen });
  if (links.length === 0 && !actions.resend) return null;

  const resend = async () => {
    setWorking(true);
    setError(null);
    setOutcome(null);
    await act(async () => {
      const res = await resendClosureForm(d.id);
      if (res.ok) setOutcome(res.data.chatLink);
      else setError(errorKey(res.code));
      return res;
    });
    setWorking(false);
  };
  const revoke = async () => {
    setWorking(true);
    setError(null);
    setOutcome(null);
    await act(() => revokeClosureForm(d.id));
    setWorking(false);
  };

  return (
    <Panel id="cmp-form-link" title={t("title")}>
      <p className="mb-2 text-xs text-muted-foreground">{t("intro")}</p>
      {links.length === 0 ? (
        <p className="mb-2 text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="mb-3 divide-y divide-border rounded-lg border border-border">
          {links.map((l) => (
            <li key={l.id} className="space-y-1 px-3 py-2 text-sm" data-link={l.id}>
              <div className="flex flex-wrap items-center gap-2">
                <LinkStateChip state={l.state} />
                {l.createdBy ? (
                  <span className="text-xs text-muted-foreground">
                    <Person person={l.createdBy} />
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("made", { when: formatWhen(l.createdAt, locale) })}
                {l.sentAt ? ` · ${t("sentAt", { when: formatWhen(l.sentAt, locale) })}` : ""}
                {l.openedAt ? ` · ${t("openedAt", { when: formatWhen(l.openedAt, locale) })}` : ""}
                {l.submittedAt ? ` · ${t("submittedAt", { when: formatWhen(l.submittedAt, locale) })}` : ""}
                {l.state === "created" || l.state === "sent" || l.state === "opened" ? ` · ${t("expires", { when: formatWhen(l.expiresAt, locale) })}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
      {error ? <Notice tone="danger">{tErr(error)}</Notice> : null}
      {outcome ? (
        <div className="mb-3">
          <ChatLinkResult outcome={outcome} />
        </div>
      ) : null}
      {actions.resend || actions.revoke ? (
        <div className="flex flex-wrap items-center gap-2">
          {actions.resend ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void resend()} disabled={busy || working}>
              {working ? t("working") : t("resend")}
            </Button>
          ) : null}
          {actions.revoke ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => void revoke()} disabled={busy || working}>
              {t("revoke")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {actions.resend ? <p className="mt-2 text-xs text-muted-foreground">{t("resendHelp")}</p> : null}
    </Panel>
  );
}
