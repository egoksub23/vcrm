"use client";

// The two small pieces the sensitive controls share: the button that shows or hides what was typed, and the hints that ask a
// password manager and the browser's autofill to leave the field alone.

import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

/** Asks a password manager and the browser's own autofill to leave the field alone. */
export const NO_REMEMBER = { autoComplete: "off", "data-1p-ignore": true, "data-lpignore": "true", "data-bwignore": "true", "data-form-type": "other" } as const;

/** The show/hide button: a real button, at least 44 px, that says what it will do and what it is for. */
export function RevealButton({ shown, onToggle, controls, label }: { shown: boolean; onToggle: () => void; controls: string; label: string }) {
  const t = useTranslations("Sign.signerForm");
  return (
    <Button type="button" variant="outline" className="size-11 shrink-0 p-0" aria-pressed={shown} aria-controls={controls} aria-label={shown ? t("sensitive.hideNamed", { label }) : t("sensitive.showNamed", { label })} onClick={onToggle}>
      {shown ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
    </Button>
  );
}

