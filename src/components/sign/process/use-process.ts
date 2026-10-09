"use client";

// ============================================================
// Doc Sign, the sending workflow's state: what the sender has typed (the people, the options), what is saved and when, which step is open, and
// what is sent. One hook for a document on its own and for a document collection: the two differ only in the routes behind `ProcessApi` and in
// what they read into a `ProcessSource` (the document on its own is read as a collection of one). The people and the options save by themselves as
// they are edited (and when a step is left); the signature editor saves its own and registers its flush here.
// ============================================================

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { useAuth } from "@/hooks/use-auth";
import { useCapability } from "@/hooks/use-can";
import { combineSaveStates, useAutosave } from "@/hooks/use-sign-autosave";
import { SignApiError, type SignIssue } from "@/lib/sign/client/api";
import type { DraftOptions } from "@/lib/sign/client/draft-options";
import { isFormMode } from "@/lib/sign/types";
import { errorKey } from "@/lib/sign/client/errors";
import { normalizePersonSteps, peopleKey, peoplePayload, personIsComplete, type PersonPayload } from "@/lib/sign/client/envelope-form";
import { hasFormParts } from "@/lib/sign/client/progress-logic";
import { PROCESS_STEPS, deriveContact, liteDocs, optionIssuesOf, processProblems, processRights, processStatus, reachableSteps, roleKeyOn, startingPeople, startingStep, summarize, type ProcessFacts, type ProcessSource, type StepId } from "@/lib/sign/client/process";
import { linksAfterContactChange } from "@/lib/sign/client/record-links";
import { isCopy, isSigner, type EnvelopePerson } from "@/lib/sign/envelopes";

/** What Send answers, for the screen after it. */
export interface SendOutcome {
  reference: string | null;
  expiresAt: string;
  invited: { signerId: string; name: string; roleKey: string; delivery: { channel: "email" | "whatsapp"; status: "sent" | "failed" | "not_configured"; detail?: string }; link?: string }[];
  documents: number;
}

/** The routes behind the workflow: a document on its own and a collection each have their own. */
export interface ProcessApi {
  savePeople: (payload: PersonPayload[], ordered: boolean) => Promise<void>;
  /** Save what differs between the saved options and the typed ones; the options as saved, or null when nothing needed saving. */
  saveOptions: (saved: DraftOptions, typed: DraftOptions) => Promise<DraftOptions | null>;
  send: () => Promise<SendOutcome>;
  remove: () => Promise<void>;
  reload: () => Promise<ProcessSource | null>;
}

interface Args {
  source: ProcessSource;
  api: ProcessApi;
  /** `?step=` and `?doc=` of the page. */
  asked?: { step?: string | null; doc?: string | null };
}

/** Where the sender is told a step cannot be opened yet. */
export interface BlockedNotice {
  step: StepId;
  by: StepId;
}

export function useProcess({ source, api, asked }: Args) {
  const router = useRouter();
  const tErr = useTranslations("Sign.send");
  const mayHold = useCapability("sign.send");
  // migration 176: only the person who uploaded a draft, or an admin, can change whether it is private, and a private draft is edited by them alone
  // (a Halo user named on it reads it): for anyone else the screens are read only, as for a person without sign.send
  const { user, isOwner, isAdmin } = useAuth();
  const { canSend, canChangePrivacy } = processRights({ mayHold, isAdmin: isOwner || isAdmin, isUploader: !!user && !!source.createdBy && source.createdBy === user.id, isPrivate: source.options.isPrivate === true });
  const docs = source.docs;
  const kind = source.kind;

  // What the screen starts from, read once; afterwards these are the sender's own edits.
  const [init] = useState(() => {
    const { saved, people } = startingPeople(docs, source.signers, source.copies);
    const options = source.options;
    const facts = { kind, docs, people, ordered: options.signInOrder, optionIssues: optionIssuesOf(options, new Date()), serverProblems: source.serverProblems };
    return { people, options, peopleKey: peopleKey(peoplePayload(saved, liteDocs(docs), options.signInOrder)), step: startingStep(processStatus(facts), asked?.step) };
  });

  const [people, setPeople] = useState<EnvelopePerson[]>(init.people);
  const [options, setOptions] = useState<DraftOptions>(init.options);
  const [step, setStepState] = useState<StepId>(init.step);
  const [openDocId, setOpenDocId] = useState<string | null>(asked?.doc ?? null);
  // the block a Fix button names (select it when the signature blocks step opens), and a count that changes each time the step is asked to land
  // somewhere (so asking for the same document twice scrolls there twice)
  const [openBlockKey, setOpenBlockKey] = useState<string | null>(null);
  const [landingNonce, setLandingNonce] = useState(0);
  const [showInvalid, setShowInvalid] = useState(false);
  const [moving, setMoving] = useState(false);
  const [blocked, setBlocked] = useState<BlockedNotice | null>(null);
  const [saveErrorCode, setSaveErrorCode] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendErrorCode, setSendErrorCode] = useState<string | null>(null);
  const [sendIssues, setSendIssues] = useState<SignIssue[]>([]);
  const [result, setResult] = useState<SendOutcome | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // The latest values, for the saves (which run later than the render that made them).
  const peopleRef = useRef(init.people);
  const optionsRef = useRef(init.options);
  const docsRef = useRef(docs);
  const apiRef = useRef(api);
  const savedPeopleKey = useRef(init.peopleKey);
  const savedOptions = useRef(init.options);
  const lastDerived = useRef<string | null>(null);
  const manualContact = useRef(false);
  const deleted = useRef(false);
  const editorFlush = useRef<(() => Promise<boolean>) | null>(null);
  useEffect(() => {
    docsRef.current = docs;
    apiRef.current = api;
  });

  const peopleSave = useAutosave(async () => {
    if (deleted.current) return;
    const payload = peoplePayload(peopleRef.current, liteDocs(docsRef.current), optionsRef.current.signInOrder);
    const key = peopleKey(payload);
    if (key === savedPeopleKey.current) return;
    try {
      await apiRef.current.savePeople(payload, optionsRef.current.signInOrder);
      savedPeopleKey.current = key;
      setSaveErrorCode(null);
      void apiRef.current.reload();
    } catch (err) {
      setSaveErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      throw err;
    }
  });

  const optionsSave = useAutosave(async () => {
    if (deleted.current) return;
    try {
      const saved = await apiRef.current.saveOptions(savedOptions.current, optionsRef.current);
      if (saved) savedOptions.current = saved;
      setSaveErrorCode(null);
      if (saved) void apiRef.current.reload();
    } catch (err) {
      setSaveErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      throw err;
    }
  });

  const flushAll = useCallback(async (): Promise<boolean> => {
    const saves = await Promise.all([peopleSave.flush(), optionsSave.flush()]);
    const editor = editorFlush.current ? await editorFlush.current() : true;
    return saves.every(Boolean) && editor;
  }, [peopleSave, optionsSave]);

  const applyOptions = (patch: Partial<DraftOptions>) => {
    const next = { ...optionsRef.current, ...patch };
    optionsRef.current = next;
    setOptions(next);
    optionsSave.touch();
  };

  const changePeople = (list: EnvelopePerson[]) => {
    peopleRef.current = list;
    setPeople(list);
    peopleSave.touch();
    // the process links itself to the contact of the first person who must sign who was picked from the contacts
    const cur = optionsRef.current;
    const linked = !!(cur.ticketId || cur.dealId);
    const next = deriveContact({ people: list, current: cur.contactId, lastDerived: lastDerived.current, manual: manualContact.current || linked });
    if (next !== cur.contactId) {
      lastDerived.current = next;
      applyOptions(linksAfterContactChange({ contactId: cur.contactId, ticketId: cur.ticketId ?? null, dealId: cur.dealId ?? null }, next));
    }
  };

  const changeOptions = (patch: Partial<DraftOptions>) => {
    // a contact (or a ticket or a deal) the sender chose is theirs: the people no longer decide it
    if (patch.contactId !== undefined || patch.ticketId !== undefined || patch.dealId !== undefined) manualContact.current = true;
    applyOptions(patch);
    // the order numbers saved with the people depend on whether the process needs signing order
    if (patch.signInOrder !== undefined) changePeople(patch.signInOrder ? normalizePersonSteps(peopleRef.current) : peopleRef.current);
  };

  /**
   * The documents were added, removed or reordered: read the process again and take the people from what the server holds. A removal or a new
   * order has the server write the signing list again, so what is on screen follows it; a person not finished yet stays, without the roles on
   * documents that are gone.
   */
  const afterDocumentsChanged = async (): Promise<void> => {
    const fresh = await apiRef.current.reload();
    // a document on its own has no documents to add or take away (its file can be replaced): its people are what is on screen
    if (!fresh || kind === "single") return;
    docsRef.current = fresh.docs;
    const freshLite = liteDocs(fresh.docs);
    const { saved, people: base } = startingPeople(fresh.docs, fresh.signers, fresh.copies);
    const here = new Set(fresh.docs.map((d) => d.id));
    const savedEmails = new Set(saved.map((p) => p.email.trim().toLowerCase()));
    const pending = peopleRef.current
      .filter((p) => !personIsComplete(p, freshLite) && !(p.email.trim() && savedEmails.has(p.email.trim().toLowerCase())))
      .map((p) => ({ ...p, roles: Object.fromEntries(Object.entries(p.roles).filter(([id]) => here.has(id))) }));
    const next = [...base.filter(isSigner), ...pending.filter(isSigner), ...base.filter(isCopy), ...pending.filter(isCopy)];
    peopleRef.current = next;
    setPeople(next);
    if (saved.length > 0) savedPeopleKey.current = peopleKey(peoplePayload(saved, freshLite, optionsRef.current.signInOrder));
  };

  // ---- derived ---------------------------------------------------------------------------------------------
  const optionIssues = optionIssuesOf(options, new Date());
  const facts: ProcessFacts = { kind, docs, people, ordered: options.signInOrder, optionIssues, serverProblems: [...source.serverProblems, ...sendIssues] };
  const status = processStatus(facts);
  const access = reachableSteps(status);
  const problems = processProblems(facts);
  const formOnly = docs.length > 0 && docs.every((d) => d.mode === "form") && (source.document ? isFormMode(source.document) : true);
  const title = options.title.trim() || docs[0]?.title || "";
  const summary = summarize(facts, title);
  // a document on its own that carries a form (a template with parts): the form, and who holds which role, for the notes about it
  const form = kind === "single" && hasFormParts(source.document?.form_snapshot) ? (source.document?.form_snapshot ?? null) : null;
  const formRows = form && docs[0] ? people.filter(isSigner).flatMap((p) => (roleKeyOn(p, docs[0]) ? [{ roleKey: roleKeyOn(p, docs[0]) }] : [])) : [];
  const saveState = combineSaveStates([peopleSave.state, optionsSave.state]);

  // ---- moving between steps -----------------------------------------------------------------------------------
  const syncUrl = (next: StepId, doc: string | null) => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("step", next);
      if (doc && next === "blocks") url.searchParams.set("doc", doc);
      else url.searchParams.delete("doc");
      window.history.replaceState(null, "", url);
    } catch {
      // no address bar to keep in step (a test, a preview)
    }
  };

  const goStep = async (next: StepId, documentId?: string | null, blockKey?: string | null): Promise<void> => {
    if (moving) return;
    const forward = PROCESS_STEPS.indexOf(next) > PROCESS_STEPS.indexOf(step);
    if (forward && !access[next].open) {
      setBlocked({ step: next, by: access[next].blockedBy ?? "people" });
      if (step === "people") setShowInvalid(true);
      return;
    }
    setBlocked(null);
    if (next === step && documentId === undefined) return;
    if (step === "people") setShowInvalid(true);
    setMoving(true);
    try {
      const ok = await flushAll();
      if (!ok) {
        setSaveErrorCode((c) => c ?? "save_failed");
        return;
      }
      // the documents' roles and blocks are read again, so the next step starts from what the server holds
      await apiRef.current.reload();
      setSendErrorCode(null);
      setOpenDocId(next === "blocks" ? (documentId ?? (kind === "single" ? (docsRef.current[0]?.id ?? null) : null)) : null);
      setOpenBlockKey(next === "blocks" && documentId ? (blockKey ?? null) : null);
      setLandingNonce((n) => n + 1);
      setStepState(next);
      syncUrl(next, documentId ?? null);
    } finally {
      setMoving(false);
    }
  };

  const send = async (): Promise<void> => {
    if (sending) return;
    setSending(true);
    setSendErrorCode(null);
    setSendIssues([]);
    try {
      if (!(await flushAll())) {
        setSendErrorCode("save_failed");
        return;
      }
      setResult(await apiRef.current.send());
    } catch (err) {
      setSendErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      if (err instanceof SignApiError) setSendIssues(err.issues);
      void apiRef.current.reload();
    } finally {
      setSending(false);
    }
  };

  const deleteDraft = async (message: string): Promise<void> => {
    setDeleting(true);
    try {
      deleted.current = true;
      await apiRef.current.remove();
      toast.success(message);
      router.push("/sign");
    } catch (err) {
      deleted.current = false;
      setDeleting(false);
      setConfirmDelete(false);
      toast.error(tErr(errorKey(err instanceof SignApiError ? err.code : "request_failed")));
    }
  };

  return {
    kind,
    canSend,
    canChangePrivacy,
    people,
    options,
    step,
    openDocId,
    openBlockKey,
    landingNonce,
    setOpenDocId,
    showInvalid,
    moving,
    blocked,
    saveErrorCode,
    saveState,
    sending,
    sendErrorCode,
    result,
    confirmDelete,
    setConfirmDelete,
    deleting,
    // derived
    docs,
    status,
    access,
    problems,
    summary,
    title,
    formOnly,
    form,
    formRows,
    // actions
    changePeople,
    changeOptions,
    afterDocumentsChanged,
    flushAll,
    goStep,
    send,
    deleteDraft,
    editorFlush: editorFlush as MutableRefObject<(() => Promise<boolean>) | null>,
    retrySave: () => void flushAll(),
    /** Read the process again (after the editor saved something). */
    refresh: () => void apiRef.current.reload(),
    clearBlocked: () => setBlocked(null),
  };
}

export type Process = ReturnType<typeof useProcess>;
