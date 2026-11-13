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

interface StandardRow {
  id: string;
  slug: string;
  name: string;
  kind: "template" | "framework";
  sector: string | null;
  regulatory_body: string | null;
  description: string | null;
  created_at: string;
}

export function IncidentStandardsCard() {
  const t = useTranslations("IncidentPlatform.incidentStandards");
  const [standards, setStandards] = useState<StandardRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  // Form state
  const [kind, setKind] = useState<"template" | "framework">("template");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [sector, setSector] = useState("");
  const [regBody, setRegBody] = useState("");
  const [desc, setDesc] = useState("");

  const load = useCallback(async () => {
    const res = await api<StandardRow[]>("/api/platform/standards");
    if (res.ok) setStandards(res.data);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial server data
    void load();
  }, [load]);

  const create = async () => {
    const trimName = name.trim();
    if (!trimName) return;
    setBusy(true);
    const res = await api<{ id: string; slug: string }>("/api/platform/standards", "POST", {
      action: kind === "template" ? "create-template" : "create-framework",
      name: trimName,
      slug: slug.trim() || undefined,
      sector: sector.trim() || undefined,
      regulatory_body: regBody.trim() || undefined,
      description: desc.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    await load();
    toast.success(t("created"));
    setName("");
    setSlug("");
    setSector("");
    setRegBody("");
    setDesc("");
  };

  const templates = (standards ?? []).filter((s) => s.kind === "template");
  const frameworks = (standards ?? []).filter((s) => s.kind === "framework");

  return (
    <Card className="border-border bg-card">
      <CardContent className="flex flex-col gap-5 p-5">
        <header>
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{t("help")}</p>
        </header>

        {standards === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("loading")}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {[{ label: t("kindTemplate"), rows: templates }, { label: t("kindFramework"), rows: frameworks }].map(({ label, rows }) =>
              rows.length > 0 ? (
                <div key={label}>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
                  <ul className="flex flex-col gap-1">
                    {rows.map((s) => (
                      <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm">
                        <span className="font-medium">{s.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">{s.slug}</span>
                        {s.regulatory_body && <Badge variant="secondary" className="text-[10px]">{s.regulatory_body}</Badge>}
                        {s.sector && <span className="text-xs text-muted-foreground">{s.sector}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null
            )}
          </div>
        )}

        <form
          className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-4"
          onSubmit={(e) => { e.preventDefault(); void create(); }}
        >
          <h3 className="text-xs font-semibold">{t("createTitle")}</h3>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-xs">
              {t("kindLabel")}
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as "template" | "framework")}
                className="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
              >
                <option value="template">{t("kindTemplate")}</option>
                <option value="framework">{t("kindFramework")}</option>
              </select>
            </label>
            <label className="flex min-w-56 flex-[3] flex-col gap-1 text-xs">
              {t("nameLabel")}
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} maxLength={120} />
            </label>
            <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs">
              {t("slugLabel")}
              <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder={t("slugPlaceholder")} maxLength={60} className="font-mono" />
            </label>
          </div>
          {kind === "template" && (
            <div className="flex flex-wrap gap-3">
              <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs">
                {t("sectorLabel")}
                <Input value={sector} onChange={(e) => setSector(e.target.value)} placeholder={t("sectorPlaceholder")} maxLength={80} />
              </label>
              <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs">
                {t("regBodyLabel")}
                <Input value={regBody} onChange={(e) => setRegBody(e.target.value)} maxLength={80} />
              </label>
            </div>
          )}
          <label className="flex flex-col gap-1 text-xs">
            {t("descLabel")}
            <Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={300} />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={busy || !name.trim()}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />}
              {kind === "template" ? t("createTemplate") : t("createFramework")}
            </Button>
            {kind === "template" && <p className="text-xs text-muted-foreground">{t("note")}</p>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
