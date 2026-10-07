"use client";

// ============================================================
// Doc Sign, the documents of a document collection that is still a draft: each one (it opens its own draft to place fields and fill in values),
// and, as long as the collection is a draft and stays within two to six documents, "Add a document" (files of the sender's own, one or several,
// or templates), "Remove" for each, and a new order (up and down, or drag). The work is done by the collection's routes; this is the screen.
// ============================================================

import { useState, type DragEvent } from "react";
import Link from "next/link";
import { AlertCircle, ArrowDown, ArrowUp, CheckCircle2, ExternalLink, GripVertical, Loader2, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { EnvelopeData } from "@/hooks/use-sign-envelope";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { collectionRequest, moveBy, moveTo, type CollectionItem } from "@/lib/sign/client/collection-list";
import { errorKey } from "@/lib/sign/client/errors";
import { ENVELOPE_MAX_DOCUMENTS, ENVELOPE_MIN_DOCUMENTS } from "@/lib/sign/envelopes";
import { cn } from "@/lib/utils";

import { CollectionList, CollectionPicker } from "./collection-builder";

interface Props {
  envelopeId: string;
  documents: EnvelopeData["documents"];
  /** How many things stand between a document and Send. */
  problemCount: (documentId: string) => number;
  canEdit: boolean;
  /** Save what is typed first (the people), so the server writes the list that is current. Resolves false when it could not be saved. */
  beforeChange: () => Promise<boolean>;
  /** After a change: read the collection again and bring the people on screen up to date. */
  onChanged: () => Promise<void>;
}

export function EnvelopeDocuments({ envelopeId, documents, problemCount, canEdit, beforeChange, onChanged }: Props) {
  const t = useTranslations("Sign.send.envelope.documents");
  const tc = useTranslations("Sign.send.collection.draft");
  const tl = useTranslations("Sign.send.collection.list");
  const tErr = useTranslations("Sign.send");

  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [items, setItems] = useState<CollectionItem<File>[]>([]);
  const [removing, setRemoving] = useState<{ id: string; title: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const count = documents.length;
  const room = ENVELOPE_MAX_DOCUMENTS - count;

  /** One change to the documents: save the people, ask the server, read it all again. */
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setErrorCode(null);
    try {
      if (!(await beforeChange())) {
        setErrorCode("save_failed");
        return false;
      }
      await action();
      await onChanged();
      return true;
    } catch (err) {
      setErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      // the collection may have changed under us (sent elsewhere, edited in another window): show what it is now
      await onChanged().catch(() => undefined);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reorder = (ids: string[]) => run(() => signRequest(`/api/sign/envelopes/${envelopeId}/documents`, { method: "PUT", json: { order: ids } }));
  const ids = documents.map((d) => d.id);

  const addItems = async () => {
    if (items.length === 0) return;
    const ok = await run(async () => {
      await signRequest(`/api/sign/envelopes/${envelopeId}/documents`, collectionRequest(items));
    });
    if (ok) {
      toast.success(tc("added", { count: items.length }));
      setItems([]);
      setAdding(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    const target = removing;
    const ok = await run(async () => {
      await signRequest(`/api/sign/envelopes/${envelopeId}/documents/${target.id}`, { method: "DELETE" });
    });
    setRemoving(null);
    if (ok) toast.success(tc("removed"));
  };

  const drop = (targetId: string) => {
    const from = ids.indexOf(dragId ?? "");
    const to = ids.indexOf(targetId);
    setDragId(null);
    setOverId(null);
    if (from >= 0 && to >= 0 && from !== to) void reorder(moveTo(ids, from, to));
  };

  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {documents.map((d, i) => {
          const problems = problemCount(d.id);
          return (
            <li
              key={d.id}
              draggable={canEdit && !busy}
              onDragStart={(e: DragEvent) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", d.id);
                setDragId(d.id);
              }}
              onDragOver={(e: DragEvent) => {
                if (!dragId) return;
                e.preventDefault();
                if (overId !== d.id) setOverId(d.id);
              }}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                drop(d.id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              className={cn("flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2", dragId === d.id && "opacity-50", dragId && overId === d.id && dragId !== d.id ? "border-primary" : "border-border")}
            >
              <div className="flex min-w-0 items-center gap-2">
                {canEdit ? <GripVertical className={cn("size-4 shrink-0 text-muted-foreground", !busy && "cursor-grab")} aria-hidden /> : null}
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    <span className="text-muted-foreground tabular-nums">{i + 1}.</span> {d.title}
                  </p>
                  <p className="text-xs text-muted-foreground">{[d.reference, d.mode === "form" ? t("form") : t("pages", { count: d.pageCount ?? 0 })].filter(Boolean).join(" · ")}</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {problems > 0 ? <span className="text-xs font-medium text-amber-700 dark:text-amber-300">{t("problems", { count: problems })}</span> : <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-label={t("ready")} />}
                <Link href={`/sign/${d.id}`} className="inline-flex h-7 items-center gap-1 rounded-lg border border-border px-2.5 text-[0.8rem] font-medium hover:bg-muted">
                  <ExternalLink className="size-3.5" aria-hidden />
                  {t("edit")}
                </Link>
                {canEdit ? (
                  <>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={tl("moveUp", { title: d.title })} disabled={busy || i === 0} onClick={() => void reorder(moveBy(ids, i, -1))}>
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={tl("moveDown", { title: d.title })} disabled={busy || i === count - 1} onClick={() => void reorder(moveBy(ids, i, 1))}>
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={tl("remove", { title: d.title })} disabled={busy || count <= ENVELOPE_MIN_DOCUMENTS} onClick={() => setRemoving({ id: d.id, title: d.title })}>
                      <Trash2 aria-hidden />
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {errorCode ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{tErr(errorKey(errorCode))}</p>
        </div>
      ) : null}

      {canEdit ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" disabled={busy || room <= 0 || adding} onClick={() => setAdding(true)}>
              <Plus aria-hidden />
              {tc("add")}
            </Button>
            <p className="text-xs text-muted-foreground" role="status">
              {room <= 0 ? tc("full", { max: ENVELOPE_MAX_DOCUMENTS }) : count <= ENVELOPE_MIN_DOCUMENTS ? tc("minimum", { min: ENVELOPE_MIN_DOCUMENTS, count, max: ENVELOPE_MAX_DOCUMENTS }) : tc("count", { count, max: ENVELOPE_MAX_DOCUMENTS })}
            </p>
          </div>

          {adding ? (
            <div className="space-y-3 rounded-xl border border-border bg-background p-3 sm:p-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">{tc("addTitle")}</h3>
                <p className="text-xs text-muted-foreground">{tc("addHint", { room })}</p>
              </div>
              <CollectionPicker items={items} onItems={setItems} max={room} disabled={busy} />
              {items.length > 0 ? <CollectionList items={items} onItems={setItems} disabled={busy} /> : null}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setAdding(false);
                    setItems([]);
                    setErrorCode(null);
                  }}
                >
                  {tc("cancel")}
                </Button>
                <Button type="button" disabled={busy || items.length === 0} onClick={() => void addItems()}>
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
                  {tc("addConfirm", { count: items.length })}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <Dialog open={removing !== null} onOpenChange={(o) => (busy ? undefined : !o && setRemoving(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tc("removeTitle")}</DialogTitle>
            <DialogDescription>{tc("removeBody", { title: removing?.title ?? "" })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
              {tc("keep")}
            </Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
              {tc("removeConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
