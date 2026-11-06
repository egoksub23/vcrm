"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, ArrowDown, ArrowUp, Loader2, Plus, Trash2, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { channelHint } from "@/lib/incidents/platform/input";
import { labelOf, type IncidentContact } from "@/lib/incidents/platform/roles";
import type { RoleView } from "@/lib/incidents/platform/setup-data";
import { api } from "./api";

interface DirectoryResponse {
  roles: RoleView[];
  contacts: IncidentContact[];
}

const splitList = (value: string) =>
  value
    .split(/[\n,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);

const selectClass =
  "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Roles & contacts: who gets told. A role is a job; the people in it can change without touching a rule. */
export function RolesScreen() {
  const t = useTranslations("IncidentPlatform.roles");
  const [data, setData] = useState<DirectoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"roles" | "people">("roles");

  const load = useCallback(async () => {
    const res = await api<DirectoryResponse>("/api/incidents/setup/directory");
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setData(res.data);
    setSelectedId((cur) => cur ?? res.data.roles[0]?.id ?? null);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [load]);

  if (error) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />;

  const selected = data.roles.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 border-b border-border">
        {(["roles", "people"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium", tab === k ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t(`tab.${k}`)}
            <span className="ml-1.5 text-xs text-muted-foreground">{k === "roles" ? data.roles.length : data.contacts.length}</span>
          </button>
        ))}
      </div>

      {tab === "roles" ? (
        <div className="grid gap-4 md:grid-cols-[260px_1fr]">
          <RoleList roles={data.roles} selectedId={selectedId} onSelect={setSelectedId} onChanged={load} />
          {selected ? <RoleDetail key={selected.id} role={selected} contacts={data.contacts} onChanged={load} /> : null}
        </div>
      ) : (
        <PeopleList contacts={data.contacts} roles={data.roles} onChanged={load} />
      )}
    </div>
  );
}

// ---- role list --------------------------------------------------------------------------------------------------

function RoleList({ roles, selectedId, onSelect, onChanged }: { roles: RoleView[]; selectedId: string | null; onSelect: (id: string) => void; onChanged: () => Promise<void> }) {
  const t = useTranslations("IncidentPlatform.roles");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const fixed = roles.filter((r) => r.kind === "fixed");
  const dynamic = roles.filter((r) => r.kind === "per_incident");

  const add = async () => {
    const res = await api<{ role: { id: string } }>("/api/incidents/setup/roles", "POST", { name });
    if (!res.ok) return void toast.error(res.error);
    setName("");
    setAdding(false);
    await onChanged();
    onSelect(res.data.role.id);
  };

  const row = (r: RoleView) => (
    <li key={r.id}>
      <button
        type="button"
        onClick={() => onSelect(r.id)}
        className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm", r.id === selectedId ? "bg-primary/10 text-primary" : "hover:bg-muted")}
      >
        <span className="min-w-0 flex-1 truncate font-medium">{labelOf(r.name)}</span>
        {r.warnings.length > 0 ? <AlertTriangle aria-label={t("needsAttention")} className="size-3.5 shrink-0 text-amber-500" /> : null}
        {r.kind === "fixed" ? <span className="text-xs text-muted-foreground">{r.members.length}</span> : null}
      </button>
    </li>
  );

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-0.5">{fixed.map(row)}</ul>
      {adding ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("newRolePlaceholder")} autoFocus aria-label={t("newRoleName")} />
          <Button type="submit" size="sm" disabled={name.trim().length < 2}>{t("add")}</Button>
        </form>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setAdding(true)} className="self-start"><Plus />{t("newRole")}</Button>
      )}
      <div>
        <p className="mb-1 px-3 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{t("perIncident")}</p>
        <ul className="flex flex-col gap-0.5">{dynamic.map(row)}</ul>
      </div>
    </div>
  );
}

// ---- one role ---------------------------------------------------------------------------------------------------

function RoleDetail({ role, contacts, onChanged }: { role: RoleView; contacts: IncidentContact[]; onChanged: () => Promise<void> }) {
  const t = useTranslations("IncidentPlatform.roles");
  const tWarn = useTranslations("IncidentPlatform.warnings");
  const [name, setName] = useState(labelOf(role.name));
  const fixed = role.kind === "fixed";

  const patchRole = async (body: Record<string, unknown>) => {
    const res = await api(`/api/incidents/setup/roles/${role.id}`, "PATCH", body);
    if (!res.ok) return void toast.error(res.error);
    await onChanged();
  };
  const removeRole = async () => {
    const res = await api(`/api/incidents/setup/roles/${role.id}`, "DELETE");
    if (!res.ok) return void toast.error(res.error);
    await onChanged();
  };

  const ordered = [...role.members].sort((a, b) => a.position - b.position);
  const move = async (index: number, dir: -1 | 1) => {
    if (!ordered[index + dir]) return;
    // Swap the two people, then renumber 1..n so equal or gappy positions can never leave the order ambiguous.
    const next = [...ordered];
    [next[index], next[index + dir]] = [next[index + dir], next[index]];
    await Promise.all(
      next.map((m, i) => (m.position === i + 1 ? null : api(`/api/incidents/setup/roles/${role.id}/members`, "PATCH", { member_id: m.id, position: i + 1 }))),
    );
    await onChanged();
  };
  const patchMember = async (memberId: string, body: Record<string, unknown>) => {
    const res = await api(`/api/incidents/setup/roles/${role.id}/members`, "PATCH", { member_id: memberId, ...body });
    if (!res.ok) return void toast.error(res.error);
    await onChanged();
  };
  const removeMember = async (memberId: string) => {
    const res = await api(`/api/incidents/setup/roles/${role.id}/members?member_id=${memberId}`, "DELETE");
    if (!res.ok) return void toast.error(res.error);
    await onChanged();
  };

  const inRole = new Set(role.members.map((m) => m.contact_id));
  const available = contacts.filter((c) => c.is_active && !inRole.has(c.id));

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4" aria-label={labelOf(role.name)}>
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          {role.is_system ? (
            <h2 className="text-base font-semibold">{labelOf(role.name)}</h2>
          ) : (
            <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== labelOf(role.name) && void patchRole({ name })} aria-label={t("roleName")} className="max-w-xs font-semibold" />
          )}
          {role.description ? <p className="mt-0.5 text-xs text-muted-foreground">{role.description}</p> : null}
          <p className="mt-1 text-xs text-muted-foreground">{t("usedBy", { count: role.used_by })}</p>
        </div>
        {!role.is_system ? <Button variant="ghost" size="sm" onClick={() => void removeRole()}><Trash2 />{t("deleteRole")}</Button> : null}
      </header>

      {role.warnings.map((w) => (
        <p key={w} role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          {tWarn(w)}
        </p>
      ))}

      {!fixed ? (
        <p className="text-sm text-muted-foreground">{t("perIncidentHelp")}</p>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t("tell")}</span>
            <select className={selectClass} value={role.notify_mode} onChange={(e) => void patchRole({ notify_mode: e.target.value })} aria-label={t("tell")}>
              <option value="all">{t("modeAll")}</option>
              <option value="first_available">{t("modeFirst")}</option>
            </select>
          </label>

          {ordered.length === 0 ? <p className="text-sm text-muted-foreground">{t("noMembers")}</p> : null}
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {ordered.map((m, i) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
                <span className="w-5 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{m.contact?.name ?? t("unknownPerson")}</p>
                  <p className="truncate text-xs text-muted-foreground">{m.contact?.emails.join(", ")}</p>
                </div>
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={m.is_backup} onChange={(e) => void patchMember(m.id, { is_backup: e.target.checked })} />
                  {t("backup")}
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {t("awayFrom")}
                  <input type="date" className={selectClass} value={m.away_from ?? ""} onChange={(e) => void patchMember(m.id, { away_from: e.target.value || null })} />
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {t("awayTo")}
                  <input type="date" className={selectClass} value={m.away_to ?? ""} onChange={(e) => void patchMember(m.id, { away_to: e.target.value || null })} />
                </label>
                <span className="flex items-center">
                  <Button variant="ghost" size="icon-sm" aria-label={t("moveUp")} disabled={i === 0} onClick={() => void move(i, -1)}><ArrowUp /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label={t("moveDown")} disabled={i === ordered.length - 1} onClick={() => void move(i, 1)}><ArrowDown /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label={t("removeFromRole")} onClick={() => void removeMember(m.id)}><Trash2 /></Button>
                </span>
              </li>
            ))}
          </ul>

          <AddMember roleId={role.id} available={available} onChanged={onChanged} />
        </>
      )}
    </section>
  );
}

function AddMember({ roleId, available, onChanged }: { roleId: string; available: IncidentContact[]; onChanged: () => Promise<void> }) {
  const t = useTranslations("IncidentPlatform.roles");
  const [contactId, setContactId] = useState("");
  const [creating, setCreating] = useState(false);

  const add = async (id: string) => {
    const res = await api(`/api/incidents/setup/roles/${roleId}/members`, "POST", { contact_id: id });
    if (!res.ok) return void toast.error(res.error);
    setContactId("");
    await onChanged();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectClass} value={contactId} onChange={(e) => setContactId(e.target.value)} aria-label={t("choosePerson")}>
          <option value="">{t("choosePerson")}</option>
          {available.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <Button size="sm" disabled={!contactId} onClick={() => void add(contactId)}><UserPlus />{t("addToRole")}</Button>
        <Button size="sm" variant="outline" onClick={() => setCreating((v) => !v)}><Plus />{t("newPerson")}</Button>
      </div>
      {creating ? (
        <ContactForm
          onSaved={async (contact) => {
            setCreating(false);
            await add(contact.id);
          }}
        />
      ) : null}
    </div>
  );
}

// ---- people -----------------------------------------------------------------------------------------------------

function ContactForm({ initial, onSaved, onCancel }: { initial?: IncidentContact; onSaved: (c: IncidentContact) => void | Promise<void>; onCancel?: () => void }) {
  const t = useTranslations("IncidentPlatform.roles");
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<"staff" | "outside">(initial?.kind ?? "staff");
  const [emails, setEmails] = useState(initial?.emails.join(", ") ?? "");
  const [phones, setPhones] = useState(initial?.phones.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const hint = channelHint(initial?.preferred_channels ?? ["email"]);

  const save = async () => {
    setBusy(true);
    const body = { name, kind, emails: splitList(emails), phones: splitList(phones) };
    const res = initial
      ? await api<{ contact: IncidentContact }>(`/api/incidents/setup/contacts/${initial.id}`, "PATCH", body)
      : await api<{ contact: IncidentContact }>("/api/incidents/setup/contacts", "POST", body);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    await onSaved(res.data.contact);
  };

  return (
    <form
      className="grid gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="flex flex-col gap-1 text-xs">
        {t("form.name")}
        <Input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        {t("form.kind")}
        <select className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as "staff" | "outside")}>
          <option value="staff">{t("form.staff")}</option>
          <option value="outside">{t("form.outside")}</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs sm:col-span-2">
        {t("form.emails")}
        <Input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="name@school.edu.my, sports@school.edu.my" required />
        <span className="text-muted-foreground">{t("form.emailsHelp")}</span>
      </label>
      <label className="flex flex-col gap-1 text-xs sm:col-span-2">
        {t("form.phones")}
        <Input value={phones} onChange={(e) => setPhones(e.target.value)} placeholder="+60 12 345 6789" />
        <span className="text-muted-foreground">{t("form.phonesHelp")}</span>
      </label>
      {hint ? <p className="text-xs text-muted-foreground sm:col-span-2">{hint}</p> : null}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={busy || !name.trim()}>{busy ? <Loader2 className="animate-spin" /> : null}{t("form.save")}</Button>
        {onCancel ? <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t("form.cancel")}</Button> : null}
      </div>
    </form>
  );
}

function PeopleList({ contacts, roles, onChanged }: { contacts: IncidentContact[]; roles: RoleView[]; onChanged: () => Promise<void> }) {
  const t = useTranslations("IncidentPlatform.roles");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const rolesOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const r of roles) for (const m of r.members) map.set(m.contact_id, [...(map.get(m.contact_id) ?? []), labelOf(r.name)]);
    return map;
  }, [roles]);

  const remove = async (id: string) => {
    const res = await api(`/api/incidents/setup/contacts/${id}`, "DELETE");
    if (!res.ok) return void toast.error(res.error);
    await onChanged();
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button size="sm" onClick={() => setEditing("new")}><Plus />{t("newPerson")}</Button>
      </div>
      {editing === "new" ? (
        <ContactForm
          onSaved={async () => {
            setEditing(null);
            await onChanged();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {contacts.length === 0 ? <p className="text-sm text-muted-foreground">{t("noPeople")}</p> : null}
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
        {contacts.map((c) =>
          editing === c.id ? (
            <li key={c.id} className="p-3">
              <ContactForm
                initial={c}
                onSaved={async () => {
                  setEditing(null);
                  await onChanged();
                }}
                onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <li key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {c.name} <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase">{t(`form.${c.kind}`)}</span>
                  {!c.is_active ? <span className="ml-1 text-xs text-muted-foreground">{t("inactive")}</span> : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">{[...c.emails, ...c.phones].join(" · ")}</p>
                <p className="truncate text-xs text-muted-foreground">{(rolesOf.get(c.id) ?? []).join(", ") || t("noRoles")}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setEditing(c.id)}>{t("edit")}</Button>
              <Button variant="ghost" size="sm" onClick={() => void api(`/api/incidents/setup/contacts/${c.id}`, "PATCH", { is_active: !c.is_active }).then(onChanged)}>
                {c.is_active ? t("deactivate") : t("activate")}
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={t("deletePerson")} onClick={() => void remove(c.id)}><Trash2 /></Button>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
