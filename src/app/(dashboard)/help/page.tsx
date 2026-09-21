import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowRight } from "lucide-react";

import { PageCards } from "@/components/help/help-article";
import { HelpSearchPanel } from "@/components/help/help-search";
import { getHelpContent } from "@/lib/help/content";
import { startHerePages } from "@/lib/help/nav";

export default async function HelpHomePage() {
  const t = await getTranslations("Help");
  const content = getHelpContent();

  if (content.sections.length === 0) {
    return <p className="py-16 text-center text-sm text-muted-foreground">{t("emptyGuide")}</p>;
  }

  const start = startHerePages(content);

  return (
    <div className="max-w-4xl">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{t("landingTitle")}</h1>
        <p className="mt-2 text-base text-muted-foreground">{t("landingSubtitle")}</p>
        <HelpSearchPanel className="mt-5 max-w-xl" />
      </header>

      {start.length > 0 ? (
        <section aria-labelledby="help-start" className="mb-10">
          <h2 id="help-start" className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t("startHere")}
          </h2>
          <PageCards pages={start} />
        </section>
      ) : null}

      <section aria-labelledby="help-sections">
        <h2 id="help-sections" className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {t("sections")}
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {content.sections.map((s) => (
            <li key={s.slug}>
              <Link
                href={s.href}
                className="group flex h-full flex-col gap-2 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-base font-medium text-foreground group-hover:text-primary">{s.title}</span>
                  <ArrowRight
                    className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
                {s.description ? (
                  <span className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{s.description}</span>
                ) : null}
                <span className="mt-auto pt-1 text-xs text-muted-foreground">
                  {t("pagesCount", { count: s.pages.length })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
