"use client";

// Cross-conversation search with Slack-style filter chips.
// Chips: in:<channel>, from:<person>, has:links|files|mentions.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { ChevronDown, Loader2, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { useAccountMembers } from "@/hooks/use-account-members";
import { cn } from "@/lib/utils";
import type { SembangChannelSummary, SembangSearchResult } from "@/types";

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

type HasFilter = "links" | "files" | "mentions" | null;

interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channels?: SembangChannelSummary[];
}

export function SearchDialog({ open, onOpenChange, channels = [] }: SearchDialogProps) {
  const t = useTranslations("Sembang.searchDialog");
  const router = useRouter();
  const { members } = useAccountMembers();

  const [query, setQuery] = useState("");
  const [filterChannelId, setFilterChannelId] = useState<string | null>(null);
  const [filterAuthorId, setFilterAuthorId] = useState<string | null>(null);
  const [filterHas, setFilterHas] = useState<HasFilter>(null);
  const [results, setResults] = useState<SembangSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  const nonDmChannels = useMemo(() => channels.filter((c) => !c.isDm), [channels]);

  const selectedChannel = useMemo(
    () => nonDmChannels.find((c) => c.id === filterChannelId) ?? null,
    [nonDmChannels, filterChannelId],
  );
  const selectedAuthor = useMemo(
    () => members.find((m) => m.user_id === filterAuthorId) ?? null,
    [members, filterAuthorId],
  );

  const hasActiveFilter = !!(filterChannelId || filterAuthorId || filterHas);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setFilterChannelId(null);
      setFilterAuthorId(null);
      setFilterHas(null);
      setResults(null);
      setSearching(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const hasFilter = hasActiveFilter;

    if (q.length > 0 && q.length < MIN_QUERY_LENGTH && !hasFilter) {
      setResults(null);
      setSearching(false);
      return;
    }
    if (!q && !hasFilter) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);

    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (filterChannelId) params.set("channelId", filterChannelId);
    if (filterAuthorId) params.set("authorId", filterAuthorId);
    if (filterHas) params.set("has", filterHas);

    const id = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/sembang/search?${params.toString()}`, { cache: "no-store" });
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, filterChannelId, filterAuthorId, filterHas]);

  const handleSelect = (channelId: string) => {
    router.push(`/sembang?c=${channelId}`);
    onOpenChange(false);
  };

  const tooShort = query.trim().length > 0 && query.trim().length < MIN_QUERY_LENGTH && !hasActiveFilter;

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

        {/* Filter chips */}
        <div className="flex flex-wrap gap-1.5">
          {/* In channel */}
          {filterChannelId ? (
            <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
              {t("chipIn", { name: selectedChannel?.name ?? "?" })}
              <button type="button" onClick={() => setFilterChannelId(null)} aria-label={t("removeChip")}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger className="flex h-6 items-center gap-0.5 rounded-full border border-border bg-background px-2.5 text-xs hover:bg-muted">
                {t("chipInLabel")} <ChevronDown className="ml-0.5 h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-56 overflow-y-auto">
                {nonDmChannels.map((c) => (
                  <DropdownMenuItem key={c.id} onSelect={() => setFilterChannelId(c.id)}>
                    {c.icon ? <span className="mr-1">{c.icon}</span> : "#"}{c.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* From person */}
          {filterAuthorId ? (
            <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
              {t("chipFrom", { name: selectedAuthor?.full_name ?? "?" })}
              <button type="button" onClick={() => setFilterAuthorId(null)} aria-label={t("removeChip")}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger className="flex h-6 items-center gap-0.5 rounded-full border border-border bg-background px-2.5 text-xs hover:bg-muted">
                {t("chipFromLabel")} <ChevronDown className="ml-0.5 h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-56 overflow-y-auto">
                {members.map((m) => (
                  <DropdownMenuItem key={m.user_id} onSelect={() => setFilterAuthorId(m.user_id)}>
                    {m.full_name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Has */}
          {(["links", "files", "mentions"] as const).map((h) =>
            filterHas === h ? (
              <span key={h} className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                {t(`chipHas_${h}`)}
                <button type="button" onClick={() => setFilterHas(null)} aria-label={t("removeChip")}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ) : filterHas === null ? (
              <button
                key={h}
                type="button"
                onClick={() => setFilterHas(h)}
                className={cn(
                  "flex h-6 items-center rounded-full border px-2.5 text-xs transition-colors hover:bg-muted",
                )}
              >
                {t(`chipHas_${h}`)}
              </button>
            ) : null,
          )}
        </div>

        <div className="max-h-80 overflow-y-auto">
          {searching ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : tooShort ? (
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
