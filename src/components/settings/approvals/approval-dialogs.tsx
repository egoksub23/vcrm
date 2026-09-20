"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { buildEditPatch } from "@/lib/approvals/rules";
import type { ApprovalItem } from "@/lib/approvals/types";
import { TAG_DESCRIPTION_MAX, TAG_NAME_MAX } from "@/lib/tags/tag-csv";

import { TagColorPicker } from "../tags/tag-color-picker";

const NOTE_MIN = 3;
const NOTE_MAX = 500;

/** Reject: a short note is required (the proposer reads it). */
export function RejectDialog({
  item,
  busy,
  onCancel,
  onConfirm,
}: {
  item: ApprovalItem;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const t = useTranslations("Settings.approvals.reject");
  const [note, setNote] = useState("");
  const trimmed = note.trim();
  const valid = trimmed.length >= NOTE_MIN;

  return (
    <Dialog open onOpenChange={(o) => (!o && !busy ? onCancel() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { name: item.title ?? "" })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="approval-reject-note">{t("noteLabel")}</Label>
          <Textarea
            id="approval-reject-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={NOTE_MAX}
            rows={3}
            placeholder={t("notePlaceholder")}
            autoFocus
          />
          <p className="text-xs text-muted-foreground">{t("noteHint", { min: NOTE_MIN })}</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={() => onConfirm(trimmed)}
            disabled={!valid || busy}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Edit then approve: the reviewer adjusts the proposed values and approves
 * in one step. Only the fields they actually changed are sent; the proposal's
 * own values fill the rest. An interactive snippet is approved as it is (its
 * builder lives in the Quick replies editor).
 */
export function EditApproveDialog({
  item,
  busy,
  onCancel,
  onConfirm,
}: {
  item: ApprovalItem;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (edited: Record<string, unknown>) => void;
}) {
  const t = useTranslations("Settings.approvals.edit");
  const tf = useTranslations("Approvals.fields");
  const proposed = (item.proposed ?? {}) as Record<string, unknown>;
  const isTag = item.entity_type === "tag";
  const interactive = !isTag && proposed.kind === "interactive";

  const [name, setName] = useState(String(proposed.name ?? ""));
  const [description, setDescription] = useState(String(proposed.description ?? ""));
  const [color, setColor] = useState(String(proposed.color ?? "#3b82f6").toLowerCase());
  const [title, setTitle] = useState(String(proposed.title ?? ""));
  const [body, setBody] = useState(String(proposed.content_text ?? ""));

  const valid = isTag
    ? name.trim() !== ""
    : title.trim() !== "" && (interactive || body.trim() !== "");

  function submit() {
    const next: Record<string, unknown> = isTag
      ? { name: name.trim(), color, description: description.trim() || null }
      : interactive
        ? { title: title.trim() }
        : { title: title.trim(), content_text: body };
    onConfirm(buildEditPatch(proposed, next));
  }

  return (
    <Dialog open onOpenChange={(o) => (!o && !busy ? onCancel() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isTag ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="approval-edit-name">{tf("name")}</Label>
                <Input
                  id="approval-edit-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={TAG_NAME_MAX}
                  autoFocus
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="approval-edit-description">{tf("description")}</Label>
                <Textarea
                  id="approval-edit-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={TAG_DESCRIPTION_MAX}
                  rows={2}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>{tf("color")}</Label>
                <TagColorPicker value={color} onChange={setColor} />
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="approval-edit-title">{tf("title")}</Label>
                <Input
                  id="approval-edit-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                  autoFocus
                />
              </div>
              {interactive ? (
                <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                  {t("interactiveNote")}
                </p>
              ) : (
                <div className="grid gap-1.5">
                  <Label htmlFor="approval-edit-body">{tf("content_text")}</Label>
                  <Textarea
                    id="approval-edit-body"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    maxLength={4096}
                    rows={6}
                  />
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={submit} disabled={!valid || busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
