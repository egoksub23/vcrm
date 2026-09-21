import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { Breadcrumb, HelpArticle, PageCards } from "@/components/help/help-article";
import { getHelpContent } from "@/lib/help/content";
import { findPage, findSection, prevNext } from "@/lib/help/nav";

// /help/<section>          -> the section overview
// /help/<section>/<page>   -> an article
// Anything else is a 404 inside the guide's own frame.
interface Props {
  params: Promise<{ slug: string[] }>;
}

export function generateStaticParams() {
  const content = getHelpContent();
  return content.sections.flatMap((s) => [
    { slug: [s.slug] },
    ...s.pages.map((p) => ({ slug: [s.slug, p.slug] })),
  ]);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const content = getHelpContent();
  const section = findSection(content, slug[0]);
  if (!section) return {};
  if (slug.length === 1) return { title: `${section.title} · User Guide`, description: section.description };
  const page = findPage(content, slug[0], slug[1]);
  return page ? { title: `${page.title} · User Guide`, description: page.description } : {};
}

export default async function HelpSlugPage({ params }: Props) {
  const { slug } = await params;
  if (slug.length > 2) notFound();

  const content = getHelpContent();
  const section = findSection(content, slug[0]);
  if (!section) notFound();

  if (slug.length === 1) {
    const t = await getTranslations("Help");
    return (
      <div className="max-w-4xl">
        <Breadcrumb t={t} section={section} />
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{section.title}</h1>
        {section.description ? <p className="mt-2 text-base text-muted-foreground">{section.description}</p> : null}
        <h2 className="mt-8 mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {t("sectionOverview")}
        </h2>
        <PageCards pages={section.pages} />
      </div>
    );
  }

  const page = findPage(content, slug[0], slug[1]);
  if (!page) notFound();
  const { prev, next } = prevNext(content, page);
  return <HelpArticle page={page} section={section} prev={prev} next={next} />;
}
