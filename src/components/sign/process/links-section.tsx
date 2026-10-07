"use client";

// ============================================================
// Doc Sign, "Links (optional)" on the last step of the sending workflow: the ticket and the deal the process is attached to, and the contact it is
// linked to. The contact is not asked for at the start: the process links itself to the contact of the first person who must sign who was picked
// from the contacts (or the one a contact's page started it for), shown here with a way to change or remove it.
// ============================================================

import { useTranslations } from "next-intl";

import type { DraftOptions } from "@/lib/sign/client/draft-options";
import { linksAfterContactChange, linksAfterRecord, type DocumentLinksState } from "@/lib/sign/client/record-links";

import { ContactPicker } from "../send/contact-picker";
import { RecordPicker } from "../send/record-picker";

interface Props {
  options: DraftOptions;
  readOnly: boolean;
  onChange: (patch: Partial<DraftOptions>) => void;
}

export function LinksSection({ options, readOnly, onChange }: Props) {
  const t = useTranslations("Sign.process.links");
  const tr = useTranslations("Sign.send.records");
  // the contact, the ticket and the deal must agree (F-51): changing the contact detaches records of the old one, choosing a record fills an empty contact
  const links: DocumentLinksState = { contactId: options.contactId, ticketId: options.ticketId ?? null, dealId: options.dealId ?? null };

  return (
    <section aria-labelledby="process-links" className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5" id="process-links">
      <div>
        <h3 id="process-links" className="text-sm font-semibold text-foreground">
          {t("heading")}
        </h3>
        <p className="text-xs text-muted-foreground">{t("intro")}</p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="link-contact" className="text-sm font-medium text-foreground">
          {options.contactId ? t("contactLinked") : t("contact")}
        </label>
        <ContactPicker id="link-contact" contactId={options.contactId} disabled={readOnly} onChange={(c) => onChange(linksAfterContactChange(links, c?.id ?? null))} />
        <p className="text-xs text-muted-foreground">{options.contactId ? t("contactAutoHint") : t("contactHint")}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="link-ticket" className="text-sm font-medium text-foreground">
            {tr("ticketLabel")}
          </label>
          <RecordPicker id="link-ticket" kind="ticket" value={links.ticketId} contactId={options.contactId} disabled={readOnly} onChange={(r) => onChange(linksAfterRecord(links, "ticket", r))} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="link-deal" className="text-sm font-medium text-foreground">
            {tr("dealLabel")}
          </label>
          <RecordPicker id="link-deal" kind="deal" value={links.dealId} contactId={options.contactId} disabled={readOnly} onChange={(r) => onChange(linksAfterRecord(links, "deal", r))} />
        </div>
      </div>
    </section>
  );
}
