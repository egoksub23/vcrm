"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MAX_LABELS, MAX_LABEL_LENGTH, addLabel, normalizeLabel, removeLabel, suggestLabels, type LabelProblem } from "@/lib/tickets/labels";
import type { KnownLabel } from "@/hooks/use-ticket-labels";
import { LabelLozenge } from "./ticket-visuals";

/**
 * Labels as removable lozenges plus an "add" combobox that suggests labels
 * already in use in the account and lets you type a new one. Reports the whole
 * new list; normalisation and the 10 x 30 caps live in lib/tickets/labels.
 */
export function TicketLabelPicker({
  labels,
  known,
  onChange,
  disabled,
}: {
  labels: string[];
  known: KnownLabel[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("Tickets.labels");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  const explain = (problem: LabelProblem) => {
    if (problem === "tooMany") toast.error(t("tooMany", { max: MAX_LABELS }));
    else if (problem === "tooLong") toast.error(t("tooLong", { max: MAX_LABEL_LENGTH }));
    else if (problem === "duplicate") toast.error(t("duplicate"));
  };

  const commit = (raw: string) => {
    const result = addLabel(labels, raw);
    if (!result.ok) {
      explain(result.problem);
      return;
    }
    onChange(result.labels);
    setText("");
  };

  const suggestions = suggestLabels(known, labels, text, 8);
  const typed = normalizeLabel(text);
  const canCreate = typed !== "" && !suggestions.includes(typed) && !labels.includes(typed);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {labels.map((l) => (
        <LabelLozenge
          key={l}
          label={l}
          onRemove={disabled ? undefined : () => onChange(removeLabel(labels, l))}
          removeLabel={t("remove", { label: l })}
        />
      ))}
      {disabled ? (
        labels.length === 0 ? <span className="text-[13px] text-muted-foreground">{t("none")}</span> : null
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            className="inline-flex h-5 items-center gap-0.5 rounded-[4px] px-1.5 text-[11px] font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={t("add")}
          >
            <Plus className="size-3" />
            {labels.length === 0 ? t("add") : null}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-60">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("placeholder")}
              maxLength={MAX_LABEL_LENGTH + 10}
              autoFocus
              aria-label={t("add")}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit(text);
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setOpen(false);
                }
              }}
              className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <div className="flex max-h-48 flex-col overflow-y-auto">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => commit(s)}
                  className="rounded px-2 py-1 text-left text-[13px] hover:bg-muted"
                >
                  {s}
                </button>
              ))}
              {canCreate ? (
                <button
                  type="button"
                  onClick={() => commit(text)}
                  className="rounded px-2 py-1 text-left text-[13px] text-primary hover:bg-muted"
                >
                  {t("create", { label: typed })}
                </button>
              ) : null}
              {suggestions.length === 0 && !canCreate ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">{t("noSuggestions")}</p>
              ) : null}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
