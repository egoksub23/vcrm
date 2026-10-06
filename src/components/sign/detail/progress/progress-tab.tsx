"use client";

// Doc Sign forms: the Progress tab of a document that carries a form. Reads the route, polls while the document is
// open, and reads again after an action (together with the document, so a new expiry shows at once).

import { useNow } from "@/hooks/use-now";
import { useSignProgress } from "@/hooks/use-sign-progress";
import type { SignDocumentRow, SignSignerRow } from "@/lib/sign/types";

import type { SignEventRow } from "../events";
import { shouldPoll, type DetailCaps } from "../logic";
import { ProgressPanel } from "./progress-panel";

interface Props {
  document: SignDocumentRow;
  signers: SignSignerRow[];
  events: SignEventRow[] | null;
  caps: DetailCaps;
  /** The tab is the one showing: nothing is read while it is not. */
  active: boolean;
  /** Read the document again (an action may have changed the expiry or a person). */
  onDocumentChanged: () => Promise<void>;
}

export function ProgressTab({ document: doc, signers, events, caps, active, onDocumentChanged }: Props) {
  const now = useNow(60_000);
  const progress = useSignProgress(doc.id, active, shouldPoll(doc.status));
  const { reload } = progress;

  return (
    <ProgressPanel
      document={doc}
      signers={signers}
      events={events}
      caps={caps}
      progress={progress.data}
      loading={progress.loading}
      error={progress.error}
      now={now}
      onChanged={async () => {
        await Promise.all([onDocumentChanged(), reload()]);
      }}
      onRetry={() => void reload()}
    />
  );
}
