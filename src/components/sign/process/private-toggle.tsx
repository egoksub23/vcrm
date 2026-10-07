"use client";

// ============================================================
// Doc Sign, step 1 (Documents): the "Private" switch (migration 176), for a document on its own and for a document collection, on the first screen
// before anything is made and on the Documents step of a draft. A private document is seen only by whoever uploaded it, the workspace's admins and
// the Halo users named as signers: other people with Doc Sign do not find it in the list, in a search, in a count or in an export.
//
// Only the uploader or an admin can change it, and only while it is a draft: anyone else sees the switch as it is, with the reason.
// ============================================================

import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";

import { Switch } from "@/components/ui/switch";

interface Props {
  /** Ids for the label and its hint (the screen can hold only one of these). */
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  /** A collection (the whole collection is private, and so each document of it) or a document on its own. */
  collection: boolean;
  /** The reader may not change it (not the uploader, not an admin, or busy). */
  disabled?: boolean;
  /** The reason it cannot be changed is who the reader is, not that something is being saved: the reason is worded. */
  notYours?: boolean;
}

export function PrivateToggle({ id, checked, onChange, collection, disabled, notYours }: Props) {
  const t = useTranslations("Sign.private");
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  return (
    <section data-private-toggle className="space-y-1.5 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <Switch id={id} checked={checked} disabled={disabled || notYours} aria-labelledby={labelId} aria-describedby={hintId} className="mt-0.5" onCheckedChange={onChange} />
        <div className="min-w-0">
          <p id={labelId} className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Lock className="size-3.5 text-muted-foreground" aria-hidden />
            {collection ? t("toggle.labelCollection") : t("toggle.labelSingle")}
          </p>
          <p id={hintId} className="text-xs text-muted-foreground">
            {collection ? t("toggle.hintCollection") : t("toggle.hintSingle")}
          </p>
          {notYours ? (
            <p className="mt-1 text-xs text-muted-foreground" role="note">
              {t("toggle.notYours")}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
