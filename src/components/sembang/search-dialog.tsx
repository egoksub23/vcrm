"use client";

// Cross-conversation search — a lightweight Dialog (not a Sheet; this is a
// one-shot "find and jump" interaction, closer to create-channel-dialog.tsx's
// Dialog usage than to the panel-style Sheets). Debounced GET
// /api/sembang/search?q= as the user types, same 300ms debounce constant
// channel-thread.tsx's own per-channel search popover uses.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import type { SembangSearchResult } from "@/types";

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const t = useTranslations("Sembang.searchDialog");
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SembangSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults(null);
      setSearching(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/sembang/search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "search failed");
        setResults((data.results as SembangSearchResult[]) ?? []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [open, query]);

  // Reuses the existing `?c=<id>` deep link page.tsx already handles.
  // Known simplification, not a bug: this opens the channel but doesn't
  // scroll to or highlight the specific message (SPEC-P2.md's frontend
  // item 6 explicitly defers that).
  const handleSelect = (channelId: string) => {
    router.push(`/sembang?c=${channelId}`);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>

        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("placeholder")}
          aria-label={t("placeholder")}
          className="h-9"
        />

        <div className="max-h-80 overflow-y-auto">
          {searching ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : query.trim().length > 0 && query.trim().length < MIN_QUERY_LENGTH ? (
            <p className="py-6 text-center text-xs text-muted-foreground">{t("tooShort")}</p>
          ) : results === null ? null : results.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("noResults")}</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {results.map((r) => (
                <button
                  key={r.message.id}
                  type="button"
                  onClick={() => handleSelect(r.channel.id)}
                  className="flex items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted"
                >
                  <PersonAvatar
                    name={r.message.author?.fullName}
                    avatarUrl={r.message.author?.avatarUrl}
                    size="sm"
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-xs font-semibold text-foreground">
                        {r.message.author?.fullName ?? t("unknownAuthor")}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {format(new Date(r.message.createdAt), "MMM d, HH:mm")}
                      </span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {r.channel.isDm
                        ? r.channel.dmParticipantNames?.join(", ") || t("directMessage")
                        : `#${r.channel.name ?? ""}`}
                    </p>
                    <p className="truncate text-sm text-foreground">{r.message.body}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
