"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

export function AckButton({ token, initiallyDone }: { token: string; initiallyDone: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">(initiallyDone ? "done" : "idle");

  const acknowledge = async () => {
    setState("sending");
    try {
      const res = await fetch("/api/public/incident-ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  };

  if (state === "done") {
    return (
      <p role="status" className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm font-medium">
        Thank you. Your acknowledgement is recorded.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Button size="lg" onClick={() => void acknowledge()} disabled={state === "sending"}>
        {state === "sending" ? "Recording..." : "I have seen this"}
      </Button>
      {state === "error" ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          That did not work. Check your connection and try again.
        </p>
      ) : null}
    </div>
  );
}
