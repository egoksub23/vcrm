import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import "@/components/help/help.css";
import { HelpShell } from "@/components/help/help-shell";
import { getHelpContent } from "@/lib/help/content";
import { buildNav } from "@/lib/help/nav";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Help");
  return { title: t("pageTitle") };
}

// Guide pages are plain server components over files in content/help. The
// content is read when the page renders (and cached in production), so a new
// release picks up new pages without any extra step.
export default function HelpLayout({ children }: { children: React.ReactNode }) {
  const nav = buildNav(getHelpContent());
  return <HelpShell nav={nav}>{children}</HelpShell>;
}
