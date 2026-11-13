"use client";

import { useState } from "react";

export function ApprovalForm({
  token,
  decision,
  alreadyDecided,
}: {
  token: string;
  decision: "a" | "r";
  alreadyDecided: boolean;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(alreadyDecided);
  const [error, setError] = useState<string | null>(null);

  if (done) {
    return (
      <p className="rounded-lg bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-700 dark:text-emerald-400">
        {decision === "a" ? "You approved this. Thank you." : "Your rejection has been recorded."}
      </p>
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/public/incident-approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, note: note.trim() || null }),
      });
      const data = (await res.json()) as { ok?: boolean; duplicate?: boolean; error?: string };
      if (data.ok) {
        setDone(true);
      } else {
        setError(data.error ?? "Something went wrong. Try again.");
      }
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {decision === "r" ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="note" className="text-sm font-medium">
            Reason for rejection <span className="text-red-500">*</span>
          </label>
          <textarea
            id="note"
            className="min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="What needs to be put right before you can approve?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Confirm that you approve this. The incident will move to the next step.
        </p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <button
        onClick={submit}
        disabled={busy || (decision === "r" && !note.trim())}
        className="inline-flex items-center justify-center rounded-md px-5 py-2.5 text-sm font-semibold text-white transition-colors disabled:pointer-events-none disabled:opacity-50"
        style={{ background: decision === "a" ? "#027A48" : "#B42318" }}
      >
        {busy ? "Saving…" : decision === "a" ? "Confirm approval" : "Submit rejection"}
      </button>
    </div>
  );
}
