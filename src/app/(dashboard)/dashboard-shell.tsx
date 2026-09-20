"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { AccountAccessAlert } from "@/components/layout/account-access-alert";
import { PageGuard } from "@/components/auth/page-guard";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { BrowserNotificationsListener } from "@/components/notifications/browser-notifications-listener";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

// Collapsible hover-expand left nav (Navigation & Layout P2 gap-analysis
// item) — the user's pin/collapse preference, synced with localStorage
// via useSyncExternalStore rather than an effect + setState. That reads
// correctly on the very first client render (no extra post-mount
// re-render) and gives React an explicit SSR snapshot (`true`, matching
// today's always-expanded default) instead of risking a hydration
// mismatch from reading localStorage during a lazy useState initializer.
const SIDEBAR_PINNED_KEY = "vircle:sidebarPinned";
const SIDEBAR_PINNED_EVENT = "vircle:sidebarPinnedChange";

function subscribeSidebarPinned(callback: () => void) {
  window.addEventListener(SIDEBAR_PINNED_EVENT, callback);
  return () => window.removeEventListener(SIDEBAR_PINNED_EVENT, callback);
}

function getSidebarPinnedSnapshot(): boolean {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_PINNED_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

function getSidebarPinnedServerSnapshot(): boolean {
  return true;
}

function setSidebarPinnedStorage(value: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_PINNED_KEY, String(value));
  } catch {
    // Best-effort only — losing the preference isn't worth surfacing.
  }
  window.dispatchEvent(new Event(SIDEBAR_PINNED_EVENT));
}

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const t = useTranslations("DashboardShell");

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  // `pinned` = the user's desktop preference (expanded vs. an icon-only
  // rail that hover-expands). `Sidebar` itself is always `fixed`
  // (renders as an overlay so hover-expand never reflows the page) —
  // dashboard-shell's spacer div reserves its footprint in the flex
  // layout instead (see below).
  const sidebarPinned = useSyncExternalStore(
    subscribeSidebarPinned,
    getSidebarPinnedSnapshot,
    getSidebarPinnedServerSnapshot,
  );
  const toggleSidebarPinned = useCallback(() => {
    setSidebarPinnedStorage(!getSidebarPinnedSnapshot());
  }, []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      {/* Desktop alerts for new customer messages (opt-in via Settings →
          Your profile). Headless — renders nothing. */}
      <BrowserNotificationsListener />
      <Sidebar
        open={sidebarOpen}
        onClose={closeSidebar}
        pinned={sidebarPinned}
        onTogglePinned={toggleSidebarPinned}
      />
      {/* Reserves the fixed/overlay Sidebar's footprint in the flex row —
          see the sidebarPinned comment above. Desktop-only; mobile's
          drawer is fixed + backdrop, not part of this flex flow. */}
      <div
        className="hidden shrink-0 transition-[width] duration-200 lg:block"
        style={{ width: sidebarPinned ? "15rem" : "4rem" }}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          {/* Above every page: writes are being rejected and here's why.
              Renders nothing unless the account/role failed to resolve. */}
          <AccountAccessAlert />
          {/* Blocks the page (deep links too) when the caller lacks its
              menu capability; fails closed while capabilities load. */}
          <PageGuard>{children}</PageGuard>
        </main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
