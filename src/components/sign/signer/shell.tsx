"use client";

// ============================================================
// Doc Sign, signing page: the frame around every screen. The workspace's logo and name at the top (the
// person should see whose document this is), a language choice, the content, and a quiet footer. It is
// not the dashboard: nothing here is about the workspace's other documents.
// ============================================================

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import { LOCALE_NAMES } from "@/lib/i18n/locales";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import { cn } from "@/lib/utils";

const LANGUAGE_ORDER: SignerLocale[] = ["en", "ms", "zh", "ko"];

interface ShellProps {
  /** Null on a page that says nothing about any workspace (a link that is not valid). */
  workspace: { name: string; logoUrl: string | null } | null;
  locale: SignerLocale;
  onLocaleChange: (locale: SignerLocale) => void;
  product: string;
  /** The document screen uses the width of a computer screen; the others stay narrow and calm. */
  wide?: boolean;
  /** The sticky bar of the document screen needs room at the bottom. */
  bottomSpace?: boolean;
  /** A document sent to try a template out (F-10): a red band under the header says so on every screen. */
  test?: boolean;
  children: ReactNode;
}

export function Shell({ workspace, locale, onLocaleChange, product, wide, bottomSpace, test, children }: ShellProps) {
  const t = useTranslations("Sign.signer");
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <a href="#sign-main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-foreground">
        {t("common.skipToContent")}
      </a>
      <header className="border-b bg-card">
        <div className={cn("mx-auto flex w-full items-center justify-between gap-3 px-3 py-2", wide ? "max-w-6xl" : "max-w-2xl")}>
          <div className="flex min-w-0 items-center gap-2.5">
            {workspace?.logoUrl ? (
              // the workspace's own logo, from wherever they keep it
              // eslint-disable-next-line @next/next/no-img-element
              <img src={workspace.logoUrl} alt={workspace.name} className="h-9 max-w-[7rem] shrink-0 object-contain" referrerPolicy="no-referrer" />
            ) : null}
            <div className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-semibold">Vircle Secure Sign</span>
              {workspace ? <span className="block truncate text-xs text-muted-foreground">{workspace.name}</span> : null}
            </div>
          </div>
          <LanguageSwitcher locale={locale} onChange={onLocaleChange} />
        </div>
      </header>
      {test ? (
        <p role="note" className="border-b border-red-200 bg-red-50 px-3 py-2 text-center text-sm font-semibold text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {t("common.testBanner")}
        </p>
      ) : null}
      <main id="sign-main" tabIndex={-1} className={cn("mx-auto w-full flex-1 outline-none", wide ? "max-w-6xl" : "max-w-2xl px-3 py-6", bottomSpace && "pb-28")}>
        {children}
      </main>
      <footer className={cn("px-3 py-4 text-center text-xs text-muted-foreground", bottomSpace && "pb-24")}>{t("common.secured", { product })}</footer>
    </div>
  );
}

function LanguageSwitcher({ locale, onChange }: { locale: SignerLocale; onChange: (locale: SignerLocale) => void }) {
  const t = useTranslations("Sign.signer");
  return (
    <label className="flex shrink-0 items-center">
      <span className="sr-only">{t("common.language")}</span>
      <select
        value={locale}
        onChange={(e) => onChange(e.target.value as SignerLocale)}
        className="h-11 max-w-[9.5rem] rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {LANGUAGE_ORDER.map((code) => (
          // each language is written in itself, so a person can find theirs
          <option key={code} value={code} lang={code}>
            {LOCALE_NAMES[code]}
          </option>
        ))}
      </select>
    </label>
  );
}
