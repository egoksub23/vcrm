import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowLeft, ArrowRight, ChevronRight } from "lucide-react";

import { HelpEnhancer } from "@/components/help/help-enhancer";
import { HelpOutline } from "@/components/help/help-outline";
import { diskRenderOptions } from "@/lib/help/content";
import { renderMarkdown, type MarkdownLabels } from "@/lib/help/markdown";
import type { PrevNext } from "@/lib/help/nav";
import type { HelpPage, HelpSection } from "@/lib/help/types";

type T = Awaited<ReturnType<typeof getTranslations>>;

/** The translated strings baked into the article HTML (callout titles, copy button ...). */
export function markdownLabels(t: T): MarkdownLabels {
  return {
    copyCode: t("copyCode"),
    copied: t("copied"),
    // The renderer fills these placeholders in.
    zoomImage: t("zoomImage", { alt: "{alt}" }),
    linkToSection: t("linkToSection"),
    imageMissing: t("imageMissing", { file: "{file}" }),
    callouts: {
      note: t("calloutNote"),
      tip: t("calloutTip"),
      warning: t("calloutWarning"),
      important: t("calloutImportant"),
    },
  };
}

export function Breadcrumb({
  t,
  section,
  page,
}: {
  t: T;
  section: Pick<HelpSection, "title" | "href">;
  page?: string;
}) {
  return (
    <nav aria-label={t("breadcrumb")} className="mb-4">
      <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <li>
          <Link href="/help" className="hover:text-foreground hover:underline">
            {t("pageTitle")}
          </Link>
        </li>
        <li aria-hidden="true">
          <ChevronRight className="size-3" />
        </li>
        <li>
          {page ? (
            <Link href={section.href} className="hover:text-foreground hover:underline">
              {section.title}
            </Link>
          ) : (
            <span aria-current="page" className="text-foreground">
              {section.title}
            </span>
          )}
        </li>
        {page ? (
          <>
            <li aria-hidden="true">
              <ChevronRight className="size-3" />
            </li>
            <li aria-current="page" className="truncate text-foreground">
              {page}
            </li>
          </>
        ) : null}
      </ol>
    </nav>
  );
}

function PrevNextLinks({ t, prev, next }: { t: T } & PrevNext) {
  if (!prev && !next) return null;
  return (
    <nav aria-label={`${t("previous")} / ${t("next")}`} className="mt-12 grid gap-3 border-t border-border pt-6 sm:grid-cols-2">
      {prev ? (
        <Link
          href={prev.href}
          rel="prev"
          className="group flex flex-col gap-1 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50"
        >
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <ArrowLeft className="size-3" aria-hidden="true" />
            {t("previous")}
          </span>
          <span className="text-sm font-medium text-foreground group-hover:text-primary">{prev.title}</span>
        </Link>
      ) : (
        <span className="hidden sm:block" />
      )}
      {next ? (
        <Link
          href={next.href}
          rel="next"
          className="group flex flex-col items-end gap-1 rounded-xl border border-border bg-card p-4 text-right transition-colors hover:border-primary/50"
        >
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {t("next")}
            <ArrowRight className="size-3" aria-hidden="true" />
          </span>
          <span className="text-sm font-medium text-foreground group-hover:text-primary">{next.title}</span>
        </Link>
      ) : null}
    </nav>
  );
}

interface HelpArticleProps extends PrevNext {
  page: HelpPage;
  section: HelpSection;
}

/** One guide page: breadcrumb, title, article, outline, previous / next. */
export async function HelpArticle({ page, section, prev, next }: HelpArticleProps) {
  const t = await getTranslations("Help");
  const locale = await getLocale();
  const rendered = renderMarkdown(page.body, { labels: markdownLabels(t), ...diskRenderOptions() });

  // ISO dates are calendar dates: format them in UTC so they never shift a day.
  const updated = page.updated
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
        new Date(`${page.updated}T00:00:00Z`),
      )
    : null;

  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_13rem] xl:gap-10">
      <article className="min-w-0 max-w-3xl">
        <Breadcrumb t={t} section={section} page={page.title} />
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{page.title}</h1>
          <p className="mt-2 text-base text-muted-foreground">{page.description}</p>
          {updated ? (
            <p className="mt-2 text-xs text-muted-foreground">
              <time dateTime={page.updated}>{t("lastUpdated", { date: updated })}</time>
            </p>
          ) : null}
        </header>

        {/* Small screens: a plain, script-free list of the headings. */}
        {rendered.headings.length >= 2 ? (
          <details className="mb-6 rounded-lg border border-border bg-card px-3 py-2 text-sm xl:hidden">
            <summary className="cursor-pointer font-medium text-foreground">{t("onThisPage")}</summary>
            <ul className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
              {rendered.headings.map((h) => (
                <li key={h.id} className={h.depth === 3 ? "pl-4" : undefined}>
                  <a href={`#${h.id}`} className="text-muted-foreground hover:text-foreground">
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <HelpEnhancer>
          <div className="help-prose" dangerouslySetInnerHTML={{ __html: rendered.html }} />
        </HelpEnhancer>

        <PrevNextLinks t={t} prev={prev} next={next} />
      </article>

      <aside className="hidden xl:block">
        <div className="sticky top-2 max-h-[calc(100vh-9rem)] overflow-y-auto">
          <HelpOutline headings={rendered.headings} />
        </div>
      </aside>
    </div>
  );
}

/** A grid of page links (used by the section overview and the landing page). */
export function PageCards({ pages }: { pages: Pick<HelpPage, "href" | "title" | "description">[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {pages.map((p) => (
        <li key={p.href}>
          <Link
            href={p.href}
            className="group flex h-full flex-col gap-1 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50"
          >
            <span className="text-sm font-medium text-foreground group-hover:text-primary">{p.title}</span>
            <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{p.description}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
