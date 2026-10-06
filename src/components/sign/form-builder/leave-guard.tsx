"use client";

// Going from one screen of a template to another (placement editor, form builder, the library) with changes not yet
// saved asks first, so nothing is lost by a click. `go(href)` navigates, or opens the question when `dirty`.

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function useLeaveGuard(dirty: boolean): { go: (href: string) => void; dialog: ReactNode } {
  const t = useTranslations("Sign.formBuilder");
  const router = useRouter();
  const [target, setTarget] = useState<string | null>(null);
  const go = (href: string) => {
    if (dirty) setTarget(href);
    else router.push(href);
  };
  const dialog = (
    <Dialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("leave.title")}</DialogTitle>
          <DialogDescription>{t("leave.body")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setTarget(null)}>
            {t("leave.stay")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              const href = target;
              setTarget(null);
              if (href) router.push(href);
            }}
          >
            {t("leave.leave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { go, dialog };
}
