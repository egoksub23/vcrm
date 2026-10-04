"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ChevronDown, Copy } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { hostOf, type RegisteredUrlGroup } from "@/lib/platform/registered-urls";

interface UrlsAnswer {
  base: string;
  viewedHost: string;
  groups: RegisteredUrlGroup[];
}

/**
 * Settings > Channels: every address another service must hold for Halo, at Halo's own canonical
 * address, ready to copy. For a move to a new domain it is the checklist; afterwards it is the check.
 */
export function RegisteredUrlsCard() {
  const t = useTranslations("Settings.channels.urls");
  const [data, setData] = useState<UrlsAnswer | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || data) return;
    let alive = true;
    void fetch("/api/account/urls", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<UrlsAnswer>) : null))
      .then((v) => {
        if (alive) setData(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, data]);

  const copy = (url: string) => {
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success(t("copied")))
      .catch(() => toast.error(t("copyFailed")));
  };

  const viaAlias = data ? hostOf(data.base) !== data.viewedHost.toLowerCase() : false;

  return (
    <Card className="mt-6 border-border bg-card">
      <CardContent className="p-0">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 p-5 text-left"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <div>
            <h3 className="text-base font-semibold text-foreground">{t("title")}</h3>
            <p className="text-sm text-muted-foreground">{t("description")}</p>
          </div>
          <ChevronDown className={`h-5 w-5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>

        {open && (
          <div className="space-y-5 border-t border-border p-5">
            {!data ? (
              <p className="text-sm text-muted-foreground">{t("loading")}</p>
            ) : (
              <>
                <p className="text-sm text-foreground">
                  {t("base", { base: data.base })}
                  {viaAlias && <span className="ml-1 text-muted-foreground">{t("viaAlias", { host: data.viewedHost })}</span>}
                </p>
                {data.groups.map((g) => (
                  <section key={g.id} className="space-y-2">
                    <h4 className="text-sm font-medium text-foreground">{g.title}</h4>
                    <ul className="space-y-2">
                      {g.items.map((i) => (
                        <li key={i.id} className="rounded-lg border border-border p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-medium text-foreground">
                              {i.label}
                              {i.automatic && <Badge variant="secondary" className="ml-2">{t("automatic")}</Badge>}
                            </p>
                            {!i.automatic && (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                onClick={() => copy(i.url)}
                              >
                                <Copy className="h-3.5 w-3.5" aria-hidden />
                                {t("copy")}
                              </button>
                            )}
                          </div>
                          <code className="mt-1 block break-all rounded bg-muted px-2 py-1 text-xs text-foreground">{i.url}</code>
                          <p className="mt-1 text-xs text-muted-foreground">{i.where}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
