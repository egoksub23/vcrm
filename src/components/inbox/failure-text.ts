"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  explainFailure,
  type FailureInput,
  type FailureReason,
} from "@/lib/messages/failure-reason";

export interface FailureText {
  reason: FailureReason;
  /** Translated headline. */
  title: string;
  /** Translated "what to do". */
  action: string;
}

/**
 * Friendly, translated wording for a stored send failure. The kind comes
 * from the shared mapper (src/lib/messages/failure-reason.ts); the text is
 * looked up under Inbox.failure.kinds so it follows the user's language.
 * An unrecognised code shows the provider's own title and the code.
 */
export function useFailureText(): (input: FailureInput) => FailureText {
  const t = useTranslations("Inbox.failure");
  return useCallback(
    (input: FailureInput) => {
      const reason = explainFailure(input);
      if (reason.kind === "unknown") {
        const raw = reason.rawTitle
          ? reason.code != null
            ? `${reason.rawTitle} (${reason.code})`
            : reason.rawTitle
          : t("kinds.unknown.title");
        return { reason, title: raw, action: t("kinds.unknown.action") };
      }
      return {
        reason,
        title: t(`kinds.${reason.kind}.title`),
        action: t(`kinds.${reason.kind}.action`),
      };
    },
    [t],
  );
}
