"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/components/incidents/setup/api";

interface CatalogueEntry {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_hidden: boolean | null;
  position: number;
}

interface SystemTemplate {
  id: string;
  name: string;
  sector: string | null;
  regulatory_body: string | null;
  entries: CatalogueEntry[];
}

export function IncidentCatalogueCard() {
  const t = useTranslations("IncidentPlatform.incidentCatalogue");
  const [templates, setTemplates] = useState<SystemTemplate[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<SystemTemplate[]>("/api/platform/incident-catalogue");
    if (res.ok) setTemplates(res.data);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial server data
    void load();
  }, [load]);

  async function act(body: Record<string, unknown>, done: string) {
    setBusy(true);
    const res = await api<{ ok: true }>("/api/platform/incident-catalogue", "POST", body);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    await load();
    toast.success(done);
  }

  return (
    <Card className="border-border bg-card">
      <CardContent className="flex flex-col gap-5 p-5">
        <header>
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{t("help")}</p>
        </header>

        {templates === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("loading")}
          </div>
        ) : templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noTemplates")}</p>
        ) : (
          templates.map((tpl) => (
            <TemplateSection key={tpl.id} tpl={tpl} busy={busy} onRename={(id, name) => act({ action: "rename", id, name }, t("renamed"))} onRetire={(id) => act({ action: "retire", id }, t("retired"))} onAdd={(name, code, description) => act({ action: "add", standard_id: tpl.id, name, code: code || undefined, description: description || undefined }, t("added"))} />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function TemplateSection({
  tpl,
  busy,
  onRename,
  onRetire,
  onAdd,
}: {
  tpl: SystemTemplate;
  busy: boolean;
  onRename: (id: string, name: string) => void;
  onRetire: (id: string) => void;
  onAdd: (name: string, code: string, description: string) => void;
}) {
  const t = useTranslations("IncidentPlatform.incidentCatalogue");
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [confirmRetire, setConfirmRetire] = useState<string | null>(null);

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {tpl.name}{tpl.regulatory_body ? ` — ${tpl.regulatory_body}` : ""}
      </h3>
      <ul className="flex flex-col gap-1">
        {tpl.entries.map((e) => (
          <EntryRow
            key={e.id}
            entry={e}
            busy={busy}
            confirmRetire={confirmRetire}
            onConfirmRetire={setConfirmRetire}
            onRename={(name) => onRename(e.id, name)}
            onRetire={() => onRetire(e.id)}
          />
        ))}
      </ul>
      <form
        className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const name = newName.trim();
          if (!name) return;
          onAdd(name, newCode.trim(), newDesc.trim());
          setNewName("");
          setNewCode("");
          setNewDesc("");
        }}
      >
        <label className="flex min-w-28 flex-1 flex-col gap-1 text-xs">
          {t("newCode")}
          <Input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder={t("newCodePlaceholder")} maxLength={8} className="font-mono uppercase" />
        </label>
        <label className="flex min-w-56 flex-[3] flex-col gap-1 text-xs">
          {t("newName")}
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("newNamePlaceholder")} maxLength={120} />
        </label>
        <label className="flex min-w-56 flex-[3] flex-col gap-1 text-xs">
          {t("newDesc")}
          <Input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} maxLength={300} />
        </label>
        <Button type="submit" size="sm" disabled={busy || !newName.trim()}>
          <Plus />
          {t("add")}
        </Button>
      </form>
    </section>
  );
}

function EntryRow({
  entry,
  busy,
  confirmRetire,
  onConfirmRetire,
  onRename,
  onRetire,
}: {
  entry: CatalogueEntry;
  busy: boolean;
  confirmRetire: string | null;
  onConfirmRetire: (id: string | null) => void;
  onRename: (name: string) => void;
  onRetire: () => void;
}) {
  const t = useTranslations("IncidentPlatform.incidentCatalogue");
  const [name, setName] = useState(entry.name);
  const retired = entry.is_hidden === true;

  return (
    <li className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5">
      <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{entry.code}</span>
      {retired ? (
        <span className="flex-1 text-sm text-muted-foreground line-through">{entry.name}</span>
      ) : (
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== entry.name && onRename(name.trim())}
          className="h-7 flex-1 border-transparent bg-transparent text-sm shadow-none focus-visible:border-input focus-visible:bg-background"
          disabled={busy}
          aria-label={t("name")}
          maxLength={120}
        />
      )}
      {retired ? (
        <Badge variant="secondary" className="shrink-0 text-[10px]">{t("retiredBadge")}</Badge>
      ) : confirmRetire === entry.id ? (
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-xs text-muted-foreground">{t("retireConfirm")}</span>
          <Button variant="destructive" size="sm" onClick={() => { onConfirmRetire(null); onRetire(); }} disabled={busy}>{t("retireButton")}</Button>
          <Button variant="outline" size="sm" onClick={() => onConfirmRetire(null)} disabled={busy}>✕</Button>
        </div>
      ) : (
        <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" onClick={() => onConfirmRetire(entry.id)} disabled={busy}>
          {t("retireButton")}
        </Button>
      )}
    </li>
  );
}
