"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PLATFORM_FEATURES } from "@/lib/platform/features";

interface CreateDraft {
  companyName: string;
  legalName: string;
  ownerEmail: string;
  ownerName: string;
  adminEmails: string;
  plan: string;
  seats: string;
  features: Record<string, boolean>;
}

const EMPTY: CreateDraft = {
  companyName: "",
  legalName: "",
  ownerEmail: "",
  ownerName: "",
  adminEmails: "",
  plan: "",
  seats: "",
  features: {
    incidents: false,
    jira: false,
    vircle_chat: false,
    sign: false,
    sign_merchant: false,
    kyc: false,
    compliance: false,
    share: true,
  },
};

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

async function errorFrom(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export function WorkspaceCreateForm() {
  const t = useTranslations("Platform");
  const router = useRouter();
  const [draft, setDraft] = useState<CreateDraft>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  const set = <K extends keyof CreateDraft>(k: K, v: CreateDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/platform/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: draft.companyName,
          legalName: draft.legalName || undefined,
          ownerEmail: draft.ownerEmail,
          ownerName: draft.ownerName || undefined,
          adminEmails: draft.adminEmails || undefined,
          plan: draft.plan || undefined,
          seats: draft.seats ? Number(draft.seats) : undefined,
          features: draft.features,
        }),
      });
      if (!res.ok) throw new Error(await errorFrom(res, t("createFailed")));
      const body = (await res.json()) as {
        emailed: boolean;
        setPasswordUrl?: string;
        invitesSent?: string[];
        warning?: string;
      };
      if (body.setPasswordUrl) {
        setLink(body.setPasswordUrl);
      } else if (body.warning) {
        toast.warning(body.warning);
        router.push("/platform");
      } else {
        const extraCount = body.invitesSent?.length ?? 0;
        const msg = extraCount > 0
          ? `Workspace created. Welcome email sent to ${draft.ownerEmail}. Invitations sent to ${extraCount} additional admin${extraCount > 1 ? "s" : ""}.`
          : t("createdEmailed", { email: draft.ownerEmail });
        toast.success(msg);
        router.push("/platform");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("createFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = draft.companyName.trim().length > 0 && draft.ownerEmail.trim().length > 0 && !submitting;

  if (link) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Workspace created</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            No email provider is configured. Share this one-time password-setup link with the workspace owner.
          </p>
        </div>
        <Card className="border-border bg-card">
          <CardContent className="space-y-4 p-6">
            <div className="space-y-1.5">
              <Label>One-time link</Label>
              <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            </div>
            <p className="text-xs text-muted-foreground">
              This link can be used once to set a password. It expires after a short time.
            </p>
          </CardContent>
        </Card>
        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(link);
              toast.success("Copied to clipboard");
            }}
          >
            Copy link
          </Button>
          <Button onClick={() => router.push("/platform")}>Done</Button>
        </div>
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
        <h1 className="text-2xl font-semibold text-foreground">New workspace</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create a workspace and invite the initial admin team.
        </p>
      </div>

      {/* Organisation */}
      <Card className="border-border bg-card">
        <CardContent className="space-y-4 p-6">
          <h2 className="text-sm font-semibold text-foreground">Organisation</h2>
          <div className="space-y-1.5">
            <Label htmlFor="wc-company">Workspace name *</Label>
            <Input
              id="wc-company"
              placeholder="Acme School"
              value={draft.companyName}
              onChange={(e) => set("companyName", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">The display name shown inside the workspace.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wc-legal">Legal name</Label>
            <Input
              id="wc-legal"
              placeholder="Acme School Sdn Bhd"
              value={draft.legalName}
              onChange={(e) => set("legalName", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Registered legal entity name. Optional.</p>
          </div>
        </CardContent>
      </Card>

      {/* Admin team */}
      <Card className="border-border bg-card">
        <CardContent className="space-y-4 p-6">
          <h2 className="text-sm font-semibold text-foreground">Admin team</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="wc-email">Owner email *</Label>
              <Input
                id="wc-email"
                type="email"
                placeholder="owner@example.com"
                value={draft.ownerEmail}
                onChange={(e) => set("ownerEmail", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wc-name">Owner name</Label>
              <Input
                id="wc-name"
                placeholder="Jane Smith"
                value={draft.ownerName}
                onChange={(e) => set("ownerName", e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wc-admins">Additional admin emails</Label>
            <Textarea
              id="wc-admins"
              rows={3}
              placeholder={"admin1@example.com, admin2@example.com\nor one per line"}
              value={draft.adminEmails}
              onChange={(e) => set("adminEmails", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Comma or newline separated. Each will receive a Workspace Admin invitation email. Up to 10 addresses.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Plan */}
      <Card className="border-border bg-card">
        <CardContent className="space-y-4 p-6">
          <h2 className="text-sm font-semibold text-foreground">Plan &amp; limits</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="wc-plan">Plan</Label>
              <Input
                id="wc-plan"
                placeholder="standard"
                value={draft.plan}
                onChange={(e) => set("plan", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wc-seats">Seat limit</Label>
              <Input
                id="wc-seats"
                type="number"
                min={1}
                placeholder="Unlimited"
                value={draft.seats}
                onChange={(e) => set("seats", e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Features */}
      <Card className="border-border bg-card">
        <CardContent className="space-y-4 p-6">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Features</h2>
            <p className="text-xs text-muted-foreground">Choose which modules this workspace can use from day one.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {PLATFORM_FEATURES.map((f) => (
              <div key={f} className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{FEATURE_LABELS[f] ?? f}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{FEATURE_DESCS[f] ?? ""}</p>
                </div>
                <Switch
                  checked={draft.features[f] ?? false}
                  onCheckedChange={(v) =>
                    setDraft((d) => ({ ...d, features: { ...d.features, [f]: v } }))
                  }
                  className="shrink-0"
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-3 pb-8">
        <Button variant="outline" disabled={submitting} onClick={() => router.push("/platform")}>
          Cancel
        </Button>
        <Button disabled={!canSubmit} onClick={() => void submit()}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Create workspace
        </Button>
      </div>
    </div>
  );
}
