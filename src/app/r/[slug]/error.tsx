"use client";

// Something failed while the page was being drawn (not an address that is no page: that is not-found.tsx). Plain
// words, a way to try again, and nothing about the cause. The words come from the app's own messages (this
// boundary sits outside the page's own language provider).

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

export default function RegisterError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("Sign.signer");
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-semibold">{t("errors.generic")}</h1>
      <Button type="button" className="h-12 px-6 text-base" onClick={reset}>
        {t("common.tryAgain")}
      </Button>
    </main>
  );
}
