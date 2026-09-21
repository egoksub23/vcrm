"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTicketResolutions } from "@/hooks/use-ticket-resolutions";
import {
  RESOLUTION_NOTE_MAX,
  validateResolutionChoice,
  type ResolutionChoice,
} from "@/lib/tickets/resolution";
import type { TicketResolution, TicketStatus } from "@/types";

/** The Resolution select and the note box, without the dialog around them. */
export function ResolutionFields({
  resolutions,
  resolutionId,
  onResolutionChange,
  note,
  onNoteChange,
}: {
  resolutions: TicketResolution[];
  resolutionId: string | null;
  onResolutionChange: (id: string | null) => void;
  note: string;
  onNoteChange: (note: string) => void;
}) {
  const t = useTranslations("Tickets.resolution");
  const showProblem = note.length > RESOLUTION_NOTE_MAX;
  return (
    <div className="space-y-3" data-testid="resolution-fields">
      <div className="space-y-1.5">
        <Label htmlFor="resolution-select" className="text-foreground">
          {t("resolutionLabel")}
        </Label>
        {resolutions.length === 0 ? (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <Select value={resolutionId} onValueChange={(v) => onResolutionChange(v ?? null)}>
            <SelectTrigger id="resolution-select" className="w-full bg-muted" aria-label={t("resolutionLabel")}>
              <SelectValue>
                {(value: string | null) =>
                  resolutions.find((r) => r.id === value)?.name ?? (
                    <span className="text-muted-foreground">{t("placeholder")}</span>
                  )
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {resolutions.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="resolution-note" className="text-foreground">
          {t("noteLabel")}
        </Label>
        <textarea
          id="resolution-note"
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          rows={3}
          placeholder={t("notePlaceholder")}
          aria-invalid={showProblem}
          className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />
        <p className={showProblem ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {showProblem ? t("problem.noteTooLong") : t("noteCount", { count: note.length, max: RESOLUTION_NOTE_MAX })}
        </p>
      </div>
    </div>
  );
}

/**
 * The small "How was this resolved?" dialog (migration 096): a required
 * Resolution and an optional note. Used whenever a person moves tickets to
 * Resolved or Closed (`mode="move"`: one dialog for however many tickets),
 * and to change the resolution of a ticket that is already done
 * (`mode="edit"`). Cancelling changes nothing.
 */
export function TicketResolutionDialog({
  open,
  mode = "move",
  status,
  count = 1,
  resolutions,
  initial,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  mode?: "move" | "edit";
  /** The status the tickets are moving to (move mode). */
  status?: TicketStatus;
  count?: number;
  /** The resolutions that can be picked (not archived). */
  resolutions: TicketResolution[];
  /** Preselected values: the ticket's earlier resolution, or the one being changed. */
  initial?: { resolutionId: string | null; note: string | null };
  onConfirm: (choice: ResolutionChoice) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("Tickets.resolution");
  const tStatus = useTranslations("Tickets.common.status");
  const [resolutionId, setResolutionId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [shown, setShown] = useState(false);

  // Start from the given values each time the dialog opens.
  if (open !== shown) {
    setShown(open);
    if (open) {
      setResolutionId(initial?.resolutionId && resolutions.some((r) => r.id === initial.resolutionId) ? initial.resolutionId : null);
      setNote(initial?.note ?? "");
    }
  }

  const problem = validateResolutionChoice({ resolutionId, note, active: resolutions });
  const confirm = () => {
    if (problem || !resolutionId) return;
    onConfirm({ resolutionId, note: note.trim() === "" ? null : note });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md" data-testid="resolution-dialog">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {mode === "edit" ? t("editTitle") : t("title", { count })}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {mode === "edit" || !status ? t("editDescription") : t("description", { count, status: tStatus(status) })}
          </DialogDescription>
        </DialogHeader>

        <ResolutionFields
          resolutions={resolutions}
          resolutionId={resolutionId}
          onResolutionChange={setResolutionId}
          note={note}
          onNoteChange={setNote}
        />

        <DialogFooter className="border-border bg-popover">
          <Button variant="outline" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button onClick={confirm} disabled={problem !== null}>
            {mode === "edit" || !status ? t("save") : t("confirm", { status: tStatus(status) })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What the person answered. `skip`: no dialog was needed (the workspace does not require a resolution). */
export type ResolutionAnswer = { kind: "chosen"; choice: ResolutionChoice } | { kind: "skip" } | { kind: "cancel" };

interface PromptRequest {
  mode: "move" | "edit";
  status?: TicketStatus;
  count: number;
  initial?: { resolutionId: string | null; note: string | null };
}

/**
 * Ask "how was it resolved?" from an event handler and wait for the answer:
 *
 *   const { ask, dialog } = useResolutionPrompt();
 *   const answer = await ask({ status: "resolved", count: 1 });
 *   if (answer.kind === "cancel") return;   // the ticket stays where it was
 *
 * Render `dialog` once. While the workspace does not require a resolution a
 * move is never interrupted (`skip`); `mode: "edit"` always asks.
 */
export function useResolutionPrompt(): {
  ask: (request: Partial<PromptRequest> & { mode?: "move" | "edit" }) => Promise<ResolutionAnswer>;
  dialog: ReactNode;
} {
  const { active, required } = useTicketResolutions();
  const [request, setRequest] = useState<PromptRequest | null>(null);
  const resolver = useRef<((a: ResolutionAnswer) => void) | null>(null);
  const requiredRef = useRef(required);
  useEffect(() => {
    requiredRef.current = required;
  }, [required]);

  const finish = useCallback((answer: ResolutionAnswer) => {
    const done = resolver.current;
    resolver.current = null;
    setRequest(null);
    done?.(answer);
  }, []);

  const ask = useCallback(
    (req: Partial<PromptRequest>): Promise<ResolutionAnswer> => {
      const mode = req.mode ?? "move";
      if (mode === "move" && !requiredRef.current) return Promise.resolve({ kind: "skip" });
      // A second question while one is open cancels the first.
      resolver.current?.({ kind: "cancel" });
      return new Promise<ResolutionAnswer>((resolve) => {
        resolver.current = resolve;
        setRequest({ mode, status: req.status, count: req.count ?? 1, initial: req.initial });
      });
    },
    [],
  );

  // Leaving the screen with the dialog open answers "cancel".
  useEffect(
    () => () => {
      resolver.current?.({ kind: "cancel" });
      resolver.current = null;
    },
    [],
  );

  const dialog = (
    <TicketResolutionDialog
      open={request !== null}
      mode={request?.mode}
      status={request?.status}
      count={request?.count}
      resolutions={active}
      initial={request?.initial}
      onConfirm={(choice) => finish({ kind: "chosen", choice })}
      onCancel={() => finish({ kind: "cancel" })}
    />
  );

  return { ask, dialog };
}
