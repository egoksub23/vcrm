"use client";

// Settings > Incidents > 24/7 incident contact (incidents.manage). Plain
// columns on accounts (migration 123) — pre-filled into every generated
// Form A/D ("Vircle incident contact (24/7)").

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";

interface Contact {
  incident_contact_name: string | null;
  incident_contact_role: string | null;
  incident_contact_mobile: string | null;
  incident_contact_email: string | null;
}

export function IncidentContactForm() {
  const t = useTranslations("Settings.incidents.contact");
  const { accountId } = useAuth();
  const [contact, setContact] = useState<Contact | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    void createClient()
      .from("accounts")
      .select("incident_contact_name, incident_contact_role, incident_contact_mobile, incident_contact_email")
      .eq("id", accountId)
      .single()
      .then(({ data }) => setContact((data as Contact) ?? null));
  }, [accountId]);

  const save = async () => {
    if (!contact) return;
    setSaving(true);
    try {
      const res = await fetch("/api/incidents/settings/contact", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: contact.incident_contact_name,
          role: contact.incident_contact_role,
          mobile: contact.incident_contact_mobile,
          email: contact.incident_contact_email,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t("saveFailed"));
        return;
      }
      toast.success(t("saved"));
    } finally {
      setSaving(false);
    }
  };

  if (!contact) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="size-5 animate-spin text-primary" />
      </div>
    );
  }

  const set = (key: keyof Contact) => (value: string) => setContact((prev) => (prev ? { ...prev, [key]: value } : prev));

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="inc-contact-name">{t("name")}</Label>
          <Input id="inc-contact-name" value={contact.incident_contact_name ?? ""} onChange={(e) => set("incident_contact_name")(e.target.value)} className="h-8 text-xs" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="inc-contact-role">{t("role")}</Label>
          <Input id="inc-contact-role" value={contact.incident_contact_role ?? ""} onChange={(e) => set("incident_contact_role")(e.target.value)} className="h-8 text-xs" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="inc-contact-mobile">{t("mobile")}</Label>
          <Input id="inc-contact-mobile" value={contact.incident_contact_mobile ?? ""} onChange={(e) => set("incident_contact_mobile")(e.target.value)} className="h-8 text-xs" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="inc-contact-email">{t("email")}</Label>
          <Input id="inc-contact-email" type="email" value={contact.incident_contact_email ?? ""} onChange={(e) => set("incident_contact_email")(e.target.value)} className="h-8 text-xs" />
        </div>
      </div>
      <Button size="sm" onClick={() => void save()} disabled={saving}>
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {t("save")}
      </Button>
    </div>
  );
}
