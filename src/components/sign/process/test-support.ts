// ============================================================
// Doc Sign, the sending workflow: stand-ins for the render tests. A `Process` as the steps read it, without the hook behind it, and the documents
// and people the tests share are in lib/sign/client/process-fixtures.ts. Only the tests import this.
// ============================================================

import type { DraftOptions } from "@/lib/sign/client/draft-options";
import { optionIssuesOf, processProblems, processStatus, reachableSteps, summarize, type ProcessDoc, type ProcessFacts } from "@/lib/sign/client/process";
import { baseOptions } from "@/lib/sign/client/process-fixtures";
import type { EnvelopePerson } from "@/lib/sign/envelopes";

import type { Process } from "./use-process";

const noop = () => {};
const asyncNoop = async () => {};

/** What the steps read of a process, from the documents and the people (the status, the problems and the summary are worked out as the hook does). */
export function fakeProcess(args: { kind?: "single" | "collection"; docs: ProcessDoc[]; people: EnvelopePerson[]; options?: Partial<DraftOptions>; step?: Process["step"]; serverProblems?: ProcessFacts["serverProblems"]; over?: Partial<Process> }): Process {
  const options = { ...baseOptions, ...args.options };
  const kind = args.kind ?? (args.docs.length > 1 ? "collection" : "single");
  const facts: ProcessFacts = { kind, docs: args.docs, people: args.people, ordered: options.signInOrder, optionIssues: optionIssuesOf(options, new Date("2026-10-06T08:00:00Z")), serverProblems: args.serverProblems ?? [] };
  const status = processStatus(facts);
  const process = {
    kind,
    canSend: true,
    people: args.people,
    options,
    step: args.step ?? "send",
    openDocId: null,
    setOpenDocId: noop,
    showInvalid: false,
    moving: false,
    blocked: null,
    saveErrorCode: null,
    saveState: "idle",
    sending: false,
    sendErrorCode: null,
    result: null,
    confirmDelete: false,
    setConfirmDelete: noop,
    deleting: false,
    docs: args.docs,
    status,
    access: reachableSteps(status),
    problems: processProblems(facts),
    summary: summarize(facts, options.title),
    title: options.title,
    formOnly: false,
    form: null,
    formRows: [],
    changePeople: noop,
    changeOptions: noop,
    afterDocumentsChanged: asyncNoop,
    flushAll: async () => true,
    goStep: asyncNoop,
    send: asyncNoop,
    deleteDraft: asyncNoop,
    editorFlush: { current: null },
    retrySave: noop,
    refresh: noop,
    clearBlocked: noop,
    ...args.over,
  };
  return process as unknown as Process;
}

export { baseOptions, person, processDoc, role } from "@/lib/sign/client/process-fixtures";
