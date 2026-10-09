"use client";

// ============================================================
// Secure Sign, step 3: the blocks of every document of the process, read and saved. Each document is read from its own route when the step opens
// (so the coverage is right everywhere, no file is needed for it), edited as a plain `{ fields, roles }` pair, and saved to its own document
// through the SaveHub (src/lib/sign/client/save-hub.ts): one debounced queue per document, coalesced, retried. One flush saves them all.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SignApiError, signRequest } from "@/lib/sign/client/api";
import type { EditorState } from "@/lib/sign/client/editor-history";
import { SaveHub } from "@/lib/sign/client/save-hub";
import { combineSaveStates, type SaveState } from "@/lib/sign/client/save-queue";
import { hasFormParts } from "@/lib/sign/client/progress-logic";
import type { FormDefinition } from "@/lib/sign/forms/types";
import { validateForm } from "@/lib/sign/forms/validate";
import type { PlacedField } from "@/lib/sign/pdf/types";
import { validateFields, validateRoles, type Issue } from "@/lib/sign/rules";
import { isFormMode, type SignDocumentRow, type SignRole } from "@/lib/sign/types";

/** One document as the step edits it. */
export interface BlocksDoc {
  title: string;
  fields: PlacedField[];
  roles: SignRole[];
  values: Record<string, string>;
  /** Pages, as the row says (the file's own count is used once it is open). */
  pageCount: number;
  isDraft: boolean;
  hasFile: boolean;
  fromTemplate: boolean;
  envelopeId: string | null;
  /** The form of a template with parts. */
  form: FormDefinition | null;
  /** A form with nothing printed (migration 169): no pages. */
  formOnly: boolean;
  /** The file was replaced this many times: the pages are read again. */
  fileVersion: number;
}

export type BlocksLoad = { status: "loading" } | { status: "error"; code: string } | { status: "ready"; data: BlocksDoc };

const stringValues = (raw: Record<string, unknown> | null | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) if (v !== null && v !== undefined) out[k] = String(v);
  return out;
};

export function docFromRow(d: SignDocumentRow, fileVersion = 0): BlocksDoc {
  return {
    title: d.title,
    fields: d.fields_snapshot ?? [],
    roles: d.roles_snapshot ?? [],
    values: stringValues(d.merge_values),
    pageCount: d.page_count ?? 0,
    isDraft: d.status === "draft",
    hasFile: !!d.base_path,
    fromTemplate: !!d.template_version_id,
    envelopeId: d.envelope_id ?? null,
    form: hasFormParts(d.form_snapshot) ? d.form_snapshot : null,
    formOnly: isFormMode(d),
    fileVersion,
  };
}

/** What stands between a document's blocks and the server (the same checks the editor makes): the roles, the blocks, and (with a form) the printed answers. */
export function docIssues(d: Pick<BlocksDoc, "fields" | "roles" | "form">, pageCount: number): Issue[] {
  return [...validateRoles(d.roles), ...validateFields(d.fields, d.roles, pageCount || 1), ...(d.form ? validateForm(d.form, d.roles, d.fields).filter((i) => i.code.startsWith("placement_")) : [])];
}

/** Is a document's layout read only: nobody may change it, it was sent, a template's layout not yet unlocked, or a phone. */
export function docLocked(data: Pick<BlocksDoc, "isDraft" | "fromTemplate">, env: { phone: boolean; canSend: boolean }, unlocked: boolean): boolean {
  return env.phone || !env.canSend || !data.isDraft || (data.fromTemplate && !unlocked);
}

/** How many problems keep a document's blocks from being saved: the server refuses them, so they stay on the screen until they are put right. */
export const blockedBy = (d: Pick<BlocksDoc, "fields" | "roles">, pageCount: number): number => validateRoles(d.roles).length + validateFields(d.fields, d.roles, pageCount || 1).length;

interface Args {
  docIds: readonly string[];
  /** A save reached the server: the process reads itself again (the coverage on the steps and the summary). */
  onSaved: () => void;
}

export function useBlocksData({ docIds, onSaved }: Args) {
  const [loads, setLoads] = useState<Record<string, BlocksLoad>>({});
  const [states, setStates] = useState<Record<string, SaveState>>({});
  const hub = useRef<SaveHub<EditorState, Record<string, string>> | null>(null);
  const onSavedRef = useRef(onSaved);
  const loadsRef = useRef(loads);
  useEffect(() => {
    onSavedRef.current = onSaved;
    loadsRef.current = loads;
  });

  // the hub: one for the step, a queue for each document made when it is first changed
  useEffect(() => {
    const h = new SaveHub<EditorState, Record<string, string>>({
      // (a document of a collection that was not made from a template has the people as its roles: the server keeps those in step and ignores what is sent for them)
      sendLayout: async (id, value) => {
        await signRequest(`/api/sign/documents/${id}`, { method: "PATCH", json: { fields: value.fields, roles: value.roles } });
        onSavedRef.current();
      },
      sendValues: async (id, values) => {
        await signRequest(`/api/sign/documents/${id}`, { method: "PATCH", json: { mergeValues: values } });
        onSavedRef.current();
      },
      onState: (id, s) => setStates((prev) => ({ ...prev, [id]: s })),
    });
    hub.current = h;
    const onHide = () => {
      if (document.visibilityState === "hidden" && h.unsavedDocs().length > 0) void h.flush();
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (h.unsavedDocs().length === 0) return;
      e.preventDefault();
      e.returnValue = "";
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
      hub.current = null;
      h.dispose();
    };
  }, []);

  // every document is read when the step opens, so each one's blocks are known (for the coverage) before its file is
  const fileVersions = useRef<Record<string, number>>({});
  const readDoc = useCallback(async (id: string, signal?: AbortSignal): Promise<void> => {
    try {
      const res = await signRequest<{ document: SignDocumentRow }>(`/api/sign/documents/${id}`, { signal });
      setLoads((prev) => ({ ...prev, [id]: { status: "ready", data: docFromRow(res.document, fileVersions.current[id] ?? 0) } }));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setLoads((prev) => ({ ...prev, [id]: { status: "error", code: err instanceof SignApiError ? err.code : "request_failed" } }));
    }
  }, []);
  const idsKey = docIds.join("|");
  useEffect(() => {
    const controller = new AbortController();
    for (const id of idsKey ? idsKey.split("|") : []) void readDoc(id, controller.signal);
    return () => controller.abort();
  }, [idsKey, readDoc]);

  /** Read one document again (after a failed read, or after its file was replaced: then its pages are read again too). */
  const reload = useCallback(
    (id: string, fileReplaced = false) => {
      if (fileReplaced) fileVersions.current[id] = (fileVersions.current[id] ?? 0) + 1;
      setLoads((prev) => ({ ...prev, [id]: { status: "loading" } }));
      void readDoc(id);
    },
    [readDoc],
  );

  /** A document's blocks changed (a place, a move, an undo): they show at once and are saved to THAT document a moment later. */
  const setLayout = useCallback((id: string, next: EditorState) => {
    const cur = loadsRef.current[id];
    if (!cur || cur.status !== "ready") return;
    const d = cur.data;
    setLoads((prev) => {
      const l = prev[id];
      return l && l.status === "ready" ? { ...prev, [id]: { status: "ready", data: { ...l.data, fields: next.fields, roles: next.roles } } } : prev;
    });
    // a layout the server would refuse stays on the screen and is sent as soon as it is sound
    if (blockedBy(next, d.pageCount) === 0) hub.current?.scheduleLayout(id, next);
    else hub.current?.cancelLayout(id);
  }, []);

  const setValue = useCallback((id: string, key: string, value: string) => {
    const cur = loadsRef.current[id];
    if (!cur || cur.status !== "ready") return;
    const values = { ...cur.data.values, [key]: value };
    setLoads((prev) => {
      const l = prev[id];
      return l && l.status === "ready" ? { ...prev, [id]: { status: "ready", data: { ...l.data, values } } } : prev;
    });
    hub.current?.scheduleValues(id, values);
  }, []);

  const flush = useCallback(async (): Promise<boolean> => (hub.current ? hub.current.flush() : true), []);
  const flushDoc = useCallback(async (id: string): Promise<boolean> => (hub.current ? hub.current.flush(id) : true), []);

  const saveState = useMemo(() => combineSaveStates(Object.values(states)), [states]);
  const fieldsOf = useCallback((id: string): PlacedField[] | undefined => {
    const l = loads[id];
    return l && l.status === "ready" ? l.data.fields : undefined;
  }, [loads]);

  return { loads, states, saveState, setLayout, setValue, reload, flush, flushDoc, fieldsOf };
}

export type BlocksData = ReturnType<typeof useBlocksData>;
