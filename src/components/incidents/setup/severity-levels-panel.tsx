"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { IncidentSeverityLevel } from "@/lib/incidents/standard-types";
import { api } from "./api";

interface SeveritiesView {
  template: { id: string; name: string; ownCopy: boolean };
  severities: IncidentSeverityLevel[];
}

/** Severity-level editor: rename labels, change colors, reorder. Only works on a school's own template copy. */
export function SeverityLevelsPanel() {
  const t = useTranslations("IncidentPlatform.severities");
  const [data, setData] = useState<SeveritiesView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<SeveritiesView>("/api/incidents/setup/severities");
    if (res.ok) setData(res.data);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial server data
    void load();
  }, [load]);

  async function change(body: Record<string, unknown>, done?: string) {
    setBusy(true);
    const res = await api<SeveritiesView>("/api/incidents/setup/severities", "POST", body);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    setData(res.data);
    if (done) toast.success(done);
  }

  if (!data) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />;

  if (!data.template.ownCopy) {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">{t("sharedHelp", { name: data.template.name })}</p>
        </div>
        <ul className="flex flex-col gap-1.5">
          {data.severities.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-sm text-muted-foreground">
              {s.color ? (
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              ) : (
                <span className="size-2.5 shrink-0 rounded-full border border-border" />
              )}
              {s.label}
              <span className="ml-1 font-mono text-[11px]">{s.slug}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const move = (id: string, dir: "up" | "down") => {
    const idx = data.severities.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= data.severities.length) return;
    const newOrder = [...data.severities];
    [newOrder[idx], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[idx]];
    void change({ action: "reorder", order: newOrder.map((s) => s.id) }, t("reordered"));
  };

  return (
    <ul className="flex flex-col gap-2" aria-label={t("title")}>
      {data.severities.map((s, i) => (
        <SeverityRow
          key={s.id}
          s={s}
          busy={busy}
          isFirst={i === 0}
          isLast={i === data.severities.length - 1}
          onRename={(label) => void change({ action: "rename", id: s.id, label }, t("renamed"))}
          onColor={(color) => void change({ action: "patch", id: s.id, color })}
          onMove={(dir) => move(s.id, dir)}
        />
      ))}
    </ul>
  );
}

function SeverityRow({
  s,
  busy,
  isFirst,
  isLast,
  onRename,
  onColor,
  onMove,
}: {
  s: IncidentSeverityLevel;
  busy: boolean;
  isFirst: boolean;
  isLast: boolean;
  onRename: (label: string) => void;
  onColor: (color: string | null) => void;
  onMove: (dir: "up" | "down") => void;
}) {
  const t = useTranslations("IncidentPlatform.severities");
  const [label, setLabel] = useState(s.label);

  return (
    <li className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
      <div className="flex flex-col">
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onMove("up")} disabled={busy || isFirst} aria-label={t("moveUp")}>
          <ChevronUp className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onMove("down")} disabled={busy || isLast} aria-label={t("moveDown")}>
          <ChevronDown className="size-3.5" />
        </Button>
      </div>
      <input
        type="color"
        value={s.color ?? "#888888"}
        onChange={(e) => onColor(e.target.value)}
        disabled={busy}
        aria-label={t("color")}
        title={t("color")}
        className="h-7 w-7 shrink-0 cursor-pointer rounded border border-input bg-transparent p-0.5"
      />
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => label.trim() && label.trim() !== s.label && onRename(label.trim())}
        aria-label={t("label")}
        className="max-w-48 font-medium"
        maxLength={40}
      />
      <span className="ml-auto font-mono text-xs text-muted-foreground">{s.slug}</span>
    </li>
  );
}
