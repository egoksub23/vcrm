"use client";

import { useState } from "react";
import { Loader2, Search } from "lucide-react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { useAccountMembers } from "@/hooks/use-account-members";
import { pickableMembers, type HaloMember } from "@/lib/sign/client/signers-form";

interface Props {
  /** The people already on the list: a Halo user already named on it is not offered again. */
  rows: readonly { internalUserId?: string | null }[];
  onPick: (member: HaloMember) => void;
}

/**
 * A searchable list of the workspace's members, for naming one as a person who signs from inside Halo (a countersigner).
 * Read through row level security by the shared members hook, so only this workspace's people can ever be shown; the server
 * checks again when the list is saved. Rendered only while its dialog is open, so the members are fetched when first needed.
 */
export function HaloUserPicker({ rows, onPick }: Props) {
  const t = useTranslations("Sign.send.people");
  const { members } = useAccountMembers();
  const [query, setQuery] = useState("");
  const found = pickableMembers(members, rows, query);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input className="pl-8" autoComplete="off" value={query} placeholder={t("haloUserSearch")} aria-label={t("haloUserSearch")} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {members.length === 0 ? (
        <p className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground" role="status">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {t("haloUserLoading")}
        </p>
      ) : found.length === 0 ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">{t("haloUserNone")}</p>
      ) : (
        <ul className="max-h-64 space-y-1 overflow-auto" aria-label={t("haloUserList")}>
          {found.map((m) => (
            <li key={m.user_id}>
              <button type="button" className="w-full rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" onClick={() => onPick(m)}>
                <span className="block truncate text-sm font-medium text-foreground">{m.full_name || m.email}</span>
                <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
