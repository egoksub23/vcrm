"use client";

// ============================================================
// Doc Sign, a document collection that is still a draft: hands the sending workflow (`ProcessShell`) the routes of a collection. The workflow is
// the same four steps as a document on its own; this is only what is read and where it is saved.
// ============================================================

import { useMemo } from "react";

import type { EnvelopeData } from "@/hooks/use-sign-envelope";
import { signRequest } from "@/lib/sign/client/api";
import { isEmptyPatch } from "@/lib/sign/client/draft-options";
import { envelopePatch, optionsFromEnvelope } from "@/lib/sign/client/envelope-form";
import { sourceFromEnvelope } from "@/lib/sign/client/process";
import type { SignEnvelopeRow } from "@/lib/sign/types";

import { ProcessShell } from "./process-shell";
import type { ProcessApi, SendOutcome } from "./use-process";

interface Props {
  envelopeId: string;
  data: EnvelopeData;
  reload: () => Promise<EnvelopeData | null>;
  /** Show the collection as it is now (after it was sent, or when it turns out it was sent already). */
  onOpen: () => void;
  asked?: { step?: string | null; doc?: string | null };
}

interface SendResponse {
  envelopeId: string;
  reference: string | null;
  expiresAt: string;
  invited: SendOutcome["invited"];
  documents: { id: string; title: string; reference: string | null; position: number }[];
}

export function CollectionProcess({ envelopeId, data, reload, onOpen, asked }: Props) {
  const source = useMemo(() => sourceFromEnvelope(data), [data]);
  const api = useMemo<ProcessApi>(
    () => ({
      savePeople: async (payload) => {
        await signRequest(`/api/sign/envelopes/${envelopeId}/signers`, { method: "PUT", json: { people: payload } });
      },
      saveOptions: async (saved, typed) => {
        const patch = envelopePatch(saved, typed, new Date());
        if (isEmptyPatch(patch)) return null;
        const res = await signRequest<{ envelope: SignEnvelopeRow }>(`/api/sign/envelopes/${envelopeId}`, { method: "PATCH", json: patch });
        return optionsFromEnvelope(res.envelope, { ticketId: typed.ticketId, dealId: typed.dealId });
      },
      send: async () => {
        const r = await signRequest<SendResponse>(`/api/sign/envelopes/${envelopeId}/send`, { method: "POST" });
        return { reference: r.reference, expiresAt: r.expiresAt, invited: r.invited, documents: r.documents.length };
      },
      remove: async () => {
        await signRequest(`/api/sign/envelopes/${envelopeId}`, { method: "DELETE" });
      },
      reload: async () => {
        const fresh = await reload();
        return fresh ? sourceFromEnvelope(fresh) : null;
      },
    }),
    [envelopeId, reload],
  );
  return <ProcessShell key={envelopeId} source={source} api={api} asked={asked} onOpen={onOpen} />;
}
