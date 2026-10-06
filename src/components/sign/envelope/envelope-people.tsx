"use client";

// ============================================================
// Doc Sign, an envelope's people (migration 171): ONE list for all the documents. Each person has a role on each document they are on (or none);
// they get one email and one link for all of them. Where the roles of the documents do not line up (a role nobody has, a role two people have)
// it is said here, beside the people, before the review.
// ============================================================

import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { addPerson, normalizePersonSteps, personHasInput, personIsComplete, removePerson, setPersonRole, updatePerson } from "@/lib/sign/client/envelope-form";
import { roleCoverage, type EnvelopeDocLite, type EnvelopePerson } from "@/lib/sign/envelopes";
import { normalizePhone, MAX_SIGNERS } from "@/lib/sign/rules";

interface Props {
  docs: readonly EnvelopeDocLite[];
  people: readonly EnvelopePerson[];
  ordered: boolean;
  readOnly: boolean;
  /** Show what is wrong with a person even before they have typed anything (after the review was asked for). */
  showInvalid: boolean;
  /** Whether a WhatsApp template is set up (null: not known yet). */
  whatsappConfigured: boolean | null;
  onPeople: (people: EnvelopePerson[]) => void;
  onOrdered: (ordered: boolean) => void;
}

const SELECT = "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function EnvelopePeople({ docs, people, ordered, readOnly, showInvalid, whatsappConfigured, onPeople, onOrdered }: Props) {
  const t = useTranslations("Sign.send.envelope.people");
  const change = (next: EnvelopePerson[]) => onPeople(ordered ? normalizePersonSteps(next) : next);
  const coverage = roleCoverage(docs, people);
  const titleOf = (id: string) => docs.find((d) => d.id === id)?.title ?? "";
  const labelOf = (id: string, key: string) => docs.find((d) => d.id === id)?.roles.find((r) => r.key === key)?.label ?? key;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>

      <label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox className="mt-0.5" checked={ordered} disabled={readOnly} onCheckedChange={(c) => onOrdered(!!c)} />
        <span>
          <span className="block text-sm font-medium text-foreground">{t("ordered")}</span>
          <span className="block text-xs text-muted-foreground">{t("orderedHint")}</span>
        </span>
      </label>

      {people.length === 0 ? <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">{t("empty")}</p> : null}

      <ol className="space-y-3">
        {people.map((p, i) => {
          const touched = showInvalid || personHasInput(p);
          const nameBad = touched && (!p.fullName.trim() || p.fullName.trim().length > 160);
          const emailBad = touched && !EMAIL_RE.test(p.email.trim());
          const phoneBad = touched && p.channel === "whatsapp" && normalizePhone(p.phone) === null;
          const rolesBad = touched && !personIsComplete({ ...p, fullName: "x", email: "x@x.xx", phone: "+60123456789", step: 1 }, docs);
          return (
            <li key={p.key} className="space-y-3 rounded-xl border border-border bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-foreground">{p.fullName.trim() || t("personN", { n: i + 1 })}</p>
                <Button type="button" variant="ghost" size="sm" disabled={readOnly} aria-label={t("remove", { name: p.fullName.trim() || t("personN", { n: i + 1 }) })} onClick={() => change(removePerson(people, p.key))}>
                  <Trash2 aria-hidden />
                  {t("removeShort")}
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label htmlFor={`${p.key}-name`} className="text-xs font-medium text-foreground">
                    {t("fullName")}
                  </label>
                  <Input id={`${p.key}-name`} value={p.fullName} maxLength={160} disabled={readOnly} aria-invalid={nameBad} onChange={(e) => change(updatePerson(people, p.key, { fullName: e.target.value }))} />
                  {nameBad ? <p className="text-xs text-destructive">{t("errors.name")}</p> : null}
                </div>
                <div className="space-y-1">
                  <label htmlFor={`${p.key}-email`} className="text-xs font-medium text-foreground">
                    {t("email")}
                  </label>
                  <Input id={`${p.key}-email`} type="email" value={p.email} maxLength={254} autoComplete="off" disabled={readOnly} aria-invalid={emailBad} onChange={(e) => change(updatePerson(people, p.key, { email: e.target.value }))} />
                  {emailBad ? <p className="text-xs text-destructive">{t("errors.email")}</p> : null}
                </div>
                <div className="space-y-1">
                  <label htmlFor={`${p.key}-channel`} className="text-xs font-medium text-foreground">
                    {t("channel.label")}
                  </label>
                  <select id={`${p.key}-channel`} className={SELECT} value={p.channel} disabled={readOnly} onChange={(e) => change(updatePerson(people, p.key, { channel: e.target.value === "whatsapp" ? "whatsapp" : "email" }))}>
                    <option value="email">{t("channel.email")}</option>
                    <option value="whatsapp">{t("channel.whatsapp")}</option>
                  </select>
                  {p.channel === "whatsapp" && whatsappConfigured === false ? <p className="text-xs text-amber-700 dark:text-amber-300">{t("whatsappOff")}</p> : null}
                </div>
                {p.channel === "whatsapp" ? (
                  <div className="space-y-1">
                    <label htmlFor={`${p.key}-phone`} className="text-xs font-medium text-foreground">
                      {t("phone")}
                    </label>
                    <Input id={`${p.key}-phone`} type="tel" value={p.phone} placeholder="+60123456789" disabled={readOnly} aria-invalid={phoneBad} onChange={(e) => change(updatePerson(people, p.key, { phone: e.target.value }))} />
                    {phoneBad ? <p className="text-xs text-destructive">{t("errors.phone")}</p> : null}
                  </div>
                ) : null}
                {ordered ? (
                  <div className="space-y-1">
                    <label htmlFor={`${p.key}-step`} className="text-xs font-medium text-foreground">
                      {t("step")}
                    </label>
                    <Input id={`${p.key}-step`} type="number" min={1} max={MAX_SIGNERS} value={p.step} disabled={readOnly} className="w-24" onChange={(e) => change(updatePerson(people, p.key, { step: Math.max(1, Math.min(MAX_SIGNERS, Math.floor(Number(e.target.value)) || 1)) }))} />
                    <p className="text-xs text-muted-foreground">{t("stepHint")}</p>
                  </div>
                ) : null}
              </div>

              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-foreground">{t("rolesHeading")}</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {docs.map((d) => (
                    <div key={d.id} className="space-y-1">
                      <label htmlFor={`${p.key}-${d.id}`} className="block truncate text-xs text-muted-foreground">
                        {t("roleOn", { document: d.title })}
                      </label>
                      <select id={`${p.key}-${d.id}`} className={SELECT} value={p.roles[d.id] ?? ""} disabled={readOnly} onChange={(e) => change(setPersonRole(people, p.key, d.id, e.target.value))}>
                        <option value="">{t("notOn")}</option>
                        {d.roles.map((r) => (
                          <option key={r.key} value={r.key}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                {rolesBad ? <p className="text-xs text-destructive">{t("errors.noDocument")}</p> : null}
              </fieldset>
            </li>
          );
        })}
      </ol>

      <Button type="button" variant="outline" disabled={readOnly || people.length >= MAX_SIGNERS} onClick={() => change(addPerson(people, docs))}>
        <Plus aria-hidden />
        {t("add")}
      </Button>

      {coverage.some((c) => c.people > 1 || (c.people === 0 && c.needed)) ? (
        <ul className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground" aria-label={t("conflictsLabel")}>
          {coverage
            .filter((c) => c.people > 1 || (c.people === 0 && c.needed))
            .map((c) => (
              <li key={`${c.documentId}-${c.roleKey}`}>{t(c.people === 0 ? "roleNobody" : "roleTwo", { role: labelOf(c.documentId, c.roleKey), document: titleOf(c.documentId) })}</li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
