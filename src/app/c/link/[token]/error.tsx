"use client";

// Something failed while the personal form was being drawn. Plain words, a way to try again, and nothing about the cause or the link. The words are the parent
// form's own, in the browser's language.

import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { publicWords } from "@/lib/compliance/public/words";
import { localeFromAcceptLanguage } from "@/lib/sign/client/signer-flow";

export default function PersonalFormError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const words = useMemo(() => publicWords(localeFromAcceptLanguage(typeof navigator === "undefined" ? "" : navigator.languages?.join(",") ?? navigator.language)), []);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-semibold">{words.unavailable.title}</h1>
      <p className="text-muted-foreground">{words.unavailable.body}</p>
      <Button type="button" className="h-12 px-6 text-base" onClick={reset}>
        OK
      </Button>
    </main>
  );
}
