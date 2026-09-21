import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function HelpNotFound() {
  const t = await getTranslations("Help");
  return (
    <div className="max-w-xl py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t("notFoundTitle")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("notFoundBody")}</p>
      <Link
        href="/help"
        className="mt-5 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
      >
        {t("backToGuide")}
      </Link>
    </div>
  );
}
