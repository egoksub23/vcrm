"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PLATFORM_FEATURES, isFeatureEnabled, parsePlatformRow } from "@/lib/platform/features";

const USAGE_LIMIT_FIELDS = ["contacts", "messages_per_month", "ai_tokens_per_month", "storage_mb", "sign_documents_per_month"] as const;
type UsageLimitField = (typeof USAGE_LIMIT_FIELDS)[number];

interface TenantRow {
  id: string;
  name: string;
  legal_name?: string | null;
  plan: string;
  limits: Record<string, number>;
  features: Record<string, boolean>;
}

interface EditDraft {
  name: string;
  legalName: string;
  plan: string;
  seats: string;
  broadcastPerDay: string;
  usageLimits: Record<UsageLimitField, string>;
  features: Record<string, boolean>;
}

const FEATURE_LABELS: Record<string, string> = {
  incidents: "School Incident Management",
  jira: "Jira Integration",
  vircle_chat: "Vircle Chat",
  sign: "Secure Sign",
  sign_merchant: "Merchant Registration",
  kyc: "KYC Review",
  compliance: "Compliance Requests",
  share: "Secure Share",
};

const FEATURE_DESCS: Record<string, string> = {
  incidents: "Security incident register with regulator notification forms.",
  jira: "Link tickets to Jira issues and sync status and comments.",
  vircle_chat: "In-app team messaging connected to the Vircle Chat gateway.",
  sign: "Electronic signing: upload or build documents, send for signature.",
  sign_merchant: "Merchant application and e-invoice details add-on for Secure Sign.",
  kyc: "Staff screen over the ID verification back-end.",
  compliance: "Account closures, withdrawals and phone number changes with identity check.",
  share: "Trackable document sharing with shareable links.",
};

const USAGE_LIMIT_LABELS: Record<string, string> = {
  contacts: "Contacts",
  messages_per_month: "Messages / month",
  ai_tokens_per_month: "AI tokens / month",
  storage_mb: "Storage (MB)",
  sign_documents_per_month: "Sign documents / month",
};

function toDraft(row: TenantRow): EditDraft {
  const platform = parsePlatformRow({ features: row.features });
  return {
    name: row.name,
    legalName: row.legal_name ?? "",
    plan: row.plan,
    seats: typeof row.limits?.seats === "number" ? String(row.limits.seats) : "",
    broadcastPerDay: typeof row.limits?.broadcast_per_day === "number" ? String(row.limits.broadcast_per_day) : "",
    usageLimits: Object.fromEntries(
      USAGE_LIMIT_FIELDS.map((k) => [k, typeof row.limits?.[k] === "number" ? String(row.limits[k]) : ""]),
    ) as Record<UsageLimitField, string>,
    features: Object.fromEntries(
      PLATFORM_FEATURES.map((f) => [f, isFeatureEnabled(platform, f)]),
    ),
  };
}

async function errorFrom(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export function WorkspaceEditForm({ id }: { id: string }) {
  const t = useTranslations("Platform");
  const router = useRouter();
  const [row, setRow] = useState<TenantRow | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/platform/accounts", { cache: "no-store" });
        if (!res.ok) throw new Error(await errorFrom(res, t("loadFailed")));
        const body = (await res.json()) as { accounts: TenantRow[] };
        const found = body.accounts.find((a) => a.id === id) ?? null;
        if (!found) throw new Error("Workspace not found");
        setRow(found);
        setDraft(toDraft(found));
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : t("loadFailed"));
      } finally {
        setLoading(false);
      }
    })();
  }, [id, t]);

  const save = async () => {
    if (!draft || !row) return;
    setSaving(true);
    try {
      const features: Record<string, boolean | null> = {};
      for (const f of PLATFORM_FEATURES) {
        features[f] = draft.features[f] ?? isFeatureEnabled(parsePlatformRow({ features: row.features }), f);
      }
      const body: Record<string, unknown> = {
        plan: draft.plan.trim() || row.plan,
        limits: {
          seats: draft.seats.trim() ? Number(draft.seats) : null,
          broadcast_per_day: draft.broadcastPerDay.trim() ? Number(draft.broadcastPerDay) : null,
          ...Object.fromEntries(USAGE_LIMIT_FIELDS.map((k) => [k, draft.usageLimits[k].trim() ? Number(draft.usageLimits[k]) : null])),
        },
        features,
      };
      if (draft.name.trim() && draft.name.trim() !== row.name) body.name = draft.name.trim();
      if (draft.legalName !== (row.legal_name ?? "")) {
        body.legalName = draft.legalName.trim() || null;
      }
      const res = await fetch(`/api/platform/accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await errorFrom(res, t("updateFailed")));
      toast.success(t("saved"));
      router.push("/platform");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("updateFailed"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    );
  }

  if (loadError || !draft || !row) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <Button variant="ghost" size="sm" onClick={() => router.push("/platform")}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back
        </Button>
        <p role="alert" className="text-sm text-destructive">{loadError ?? "Workspace not found"}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push("/platform")}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-semibold text-foreground">Edit workspace</h1>
        <p className="mt-1 text-sm text-muted-foreground">{row.name}</p>
      </div>

      {/* Organisation */}
      <Card className="border-border bg-card">
        <CardContent className="space-y-4 p-6">
          <h2 className="text-sm font-semibold text-foreground">Organisation</h2>
          <div className="space-y-1.5">
            <Label htmlFor="we-name">Workspace name</Label>
            <Input
              id="we-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="we-legal">Legal name</Label>
            <Input
              id="we-legal"
              placeholder="Registered legal entity name"
              value={draft.legalName}
              onChange={(e) => setDraft({ ...draft, legalName: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">Leave blank to clear.</p>
          </div>
        </CardContent>
      </Card>

      {/* Plan & limits */}
      <Card className="border-border bg-card">
        <CardContent className="space-y-4 p-6">
          <h2 className="text-sm font-semibold text-foreground">Plan &amp; limits</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="we-plan">{t("fieldPlan")}</Label>
              <Input
                id="we-plan"
                value={draft.plan}
                onChange={(e) => setDraft({ ...draft, plan: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="we-seats">{t("fieldSeats")}</Label>
              <Input
                id="we-seats"
                type="number"
                min={1}
                placeholder={t("unlimited")}
                value={draft.seats}
                onChange={(e) => setDraft({ ...draft, seats: e.target.value })}
              />
            </div>
            <div className="col-span-full space-y-1.5">
              <Label htmlFor="we-broadcast">{t("fieldBroadcastPerDay")}</Label>
              <Input
                id="we-broadcast"
                type="number"
                min={1}
                placeholder={t("unlimited")}
                value={draft.broadcastPerDay}
                onChange={(e) => setDraft({ ...draft, broadcastPerDay: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t("fieldBroadcastPerDayHint")}</p>
            </div>
            {USAGE_LIMIT_FIELDS.map((k) => (
              <div key={k} className="space-y-1.5">
                <Label htmlFor={`we-${k}`}>{USAGE_LIMIT_LABELS[k] ?? k}</Label>
                <Input
                  id={`we-${k}`}
                  type="number"
                  min={1}
                  placeholder={t("unlimited")}
                  value={draft.usageLimits[k]}
                  onChange={(e) => setDraft({ ...draft, usageLimits: { ...draft.usageLimits, [k]: e.target.value } })}
                />
              </div>
            ))}
            <p className="col-span-full text-xs text-muted-foreground">{t("fieldUsageLimitsHint")}</p>
          </div>
        </CardContent>
      </Card>

      {/* Features */}
      <Card className="border-border bg-card">
        <CardContent className="space-y-4 p-6">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Features</h2>
            <p className="text-xs text-muted-foreground">Enable or disable modules for this workspace.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {PLATFORM_FEATURES.map((f) => (
              <div key={f} className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{FEATURE_LABELS[f] ?? f}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{FEATURE_DESCS[f] ?? ""}</p>
                </div>
                <Switch
                  checked={draft.features[f] ?? true}
                  onCheckedChange={(v) => setDraft({ ...draft, features: { ...draft.features, [f]: v } })}
                  className="shrink-0"
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-3 pb-8">
        <Button variant="outline" disabled={saving} onClick={() => router.push("/platform")}>
          Cancel
        </Button>
        <Button disabled={saving || !draft.name.trim()} onClick={() => void save()}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}
