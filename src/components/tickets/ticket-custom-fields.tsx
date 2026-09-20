"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import {
  coerceValue,
  fieldsForCategory,
  fieldsForTicket,
  isEmptyValue,
} from "@/lib/tickets/custom-fields";
import { TicketFieldInput } from "./ticket-field-input";
import type { Ticket, TicketCustomValues, TicketFieldDefinition } from "@/types";

/**
 * The account's custom ticket fields (migration 066) on an existing
 * ticket. Each edit saves as it's committed (blur / selection); the local
 * draft only exists so typing isn't interrupted by a round-trip. Keyed by
 * ticket id by the parent, so it resets when a different ticket opens — but
 * NOT on every save, which would steal focus while tabbing between fields.
 */
export function CustomFieldsSection({
  ticket,
  defs,
  onSave,
  disabled,
}: {
  ticket: Ticket;
  defs: TicketFieldDefinition[];
  onSave: (next: TicketCustomValues) => Promise<boolean>;
  disabled?: boolean;
}) {
  const t = useTranslations("Tickets.detail");
  const [draft, setDraft] = useState<TicketCustomValues>(ticket.custom_fields ?? {});
  const stored = ticket.custom_fields ?? {};
  const shown = fieldsForTicket(defs, ticket.category, stored);
  if (shown.length === 0) return null;

  const requiredIds = new Set(
    fieldsForCategory(defs, ticket.category)
      .filter((d) => d.is_required)
      .map((d) => d.id),
  );

  const revert = (def: TicketFieldDefinition) =>
    setDraft((prev) => {
      const next = { ...prev };
      if (stored[def.id] === undefined) delete next[def.id];
      else next[def.id] = stored[def.id];
      return next;
    });

  const commit = async (def: TicketFieldDefinition, raw: Parameters<typeof coerceValue>[1]) => {
    const coerced = coerceValue(def, raw);
    if (coerced === stored[def.id]) return;
    if (coerced === undefined && requiredIds.has(def.id) && !isEmptyValue(stored[def.id])) {
      toast.error(t("requiredField", { field: def.label }));
      revert(def);
      return;
    }
    const next = { ...stored };
    if (coerced === undefined) delete next[def.id];
    else next[def.id] = coerced;
    if (!(await onSave(next))) revert(def);
  };

  return (
    <section className="space-y-3">
      <h3 className="text-[13px] font-semibold text-foreground">{t("customFieldsHeading")}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {shown.map((def) => (
          <TicketFieldInput
            key={def.id}
            field={def}
            value={draft[def.id]}
            onChange={(v) =>
              setDraft((prev) => {
                const next = { ...prev };
                if (v === undefined) delete next[def.id];
                else next[def.id] = v;
                return next;
              })
            }
            onCommit={(v) => void commit(def, v)}
            disabled={disabled}
            idPrefix="detail-ticket-field"
          />
        ))}
      </div>
    </section>
  );
}
