"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import { useApprovalsCount } from "@/hooks/use-approvals-count";
import { useMyTicketMentions } from "@/hooks/use-my-ticket-mentions";
import { TicketsWaitingBadge } from "@/components/tickets/tickets-waiting-badge";
import { badgeLabel } from "@/lib/approvals/rules";
import {
  BarChart3,
  Bell,
  Bot,
  BookMarked,
  BookOpen,
  ChevronsLeft,
  ChevronsRight,
  Crown,
  GitBranch,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  MessageSquare,
  Radio,
  Settings,
  Shield,
  Ticket,
  User,
  UserCog,
  Users,
  UsersRound,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import type { AccountRole } from "@/lib/auth/roles";
import { filterByCapability } from "@/lib/auth/page-access";

// Per-role chip metadata used in the sidebar's account strip + the
// Members tab roster. Keeping this near both consumers in a single
// place avoids drift between the two surfaces — when a designer
// wants to recolour "agent" rows, this is the one diff.
const ROLE_CHIP: Record<
  AccountRole,
  { icon: typeof Crown; labelKey: string; className: string }
> = {
  owner: {
    icon: Crown,
    labelKey: "roleOwner",
    // Amber: scarce, immutable, "the boss" — gets visual emphasis.
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-300",
  },
  admin: {
    icon: Shield,
    labelKey: "roleAdmin",
    // Primary-tinted: significant but not as scarce as owner.
    className:
      "border-primary/40 bg-primary/10 text-primary",
  },
  agent: {
    icon: UserCog,
    labelKey: "roleAgent",
    // Neutral slate: the operational default.
    className:
      "border-border bg-muted text-foreground",
  },
  viewer: {
    icon: User,
    labelKey: "roleViewer",
    // Muted slate: read-only role; visually quieter than agent.
    className:
      "border-border bg-card text-muted-foreground",
  },
};
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface NavItem {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
  /**
   * Menu capability that shows this item (Roles & permissions). The
   * item is hidden unless the caller holds it; the page itself is
   * guarded by the same capability in the dashboard shell.
   */
  capability?: string;
}

const navItems: NavItem[] = [
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard, capability: "menu.dashboard" },
  { href: "/inbox", labelKey: "inbox", icon: MessageSquare, capability: "menu.inbox" },
  { href: "/notifications", labelKey: "notifications", icon: Bell, capability: "menu.notifications" },
  { href: "/contacts", labelKey: "contacts", icon: Users, capability: "menu.contacts" },
  { href: "/pipelines", labelKey: "pipelines", icon: GitBranch, capability: "menu.pipelines" },
  { href: "/broadcasts", labelKey: "broadcasts", icon: Radio, capability: "menu.broadcasts" },
  { href: "/tickets", labelKey: "tickets", icon: Ticket, capability: "menu.tickets" },
  { href: "/automations", labelKey: "automations", icon: Zap, capability: "menu.automations" },
  { href: "/flows", labelKey: "flows", icon: Workflow, beta: true, capability: "menu.flows" },
  { href: "/knowledge", labelKey: "knowledge", icon: BookOpen, capability: "menu.knowledge" },
  { href: "/agents", labelKey: "aiAgents", icon: Bot, capability: "menu.agents" },
  { href: "/reports", labelKey: "reports", icon: BarChart3, capability: "menu.reports" },
];

// The User Guide is open to every signed-in role, so it carries no capability
// (and no database capability exists for it). Sembang lives here too, below
// Settings — it's internal team chat, not a customer/business-facing tool
// like the items above the divider, so it's deliberately set apart from them
// rather than mixed into the same list.
const bottomNavItems: NavItem[] = [
  { href: "/help", labelKey: "userGuide", icon: BookMarked },
  { href: "/settings", labelKey: "settings", icon: Settings, capability: "menu.settings" },
  { href: "/sembang", labelKey: "sembang", icon: MessageCircle, beta: true, capability: "menu.sembang" },
];

interface SidebarProps {
  /** Controlled on mobile by the Header's hamburger button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
  /**
   * Desktop-only collapse preference (Navigation & Layout P2 gap-analysis
   * item): true = always-expanded (today's behavior), false = an icon-
   * only rail that hover-expands. Defaults to true so any other caller
   * that doesn't pass it keeps the old always-expanded behavior.
   */
  pinned?: boolean;
  onTogglePinned?: () => void;
}

import { useTranslations } from "next-intl";

export function Sidebar({
  open = false,
  onClose,
  pinned = true,
  onTogglePinned,
}: SidebarProps) {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();
  const {
    profile,
    profileLoading,
    account,
    accountRole,
    signOut,
    capabilities,
    capabilitiesLoading,
  } = useAuth();
  // Fail closed, without a flash: while capabilities load nothing is
  // listed (items that might then disappear are never shown); a failed
  // load leaves the set empty, so the list stays empty too.
  const hasCap = (cap: string) => capabilities.has(cap);
  const visibleNavItems = capabilitiesLoading
    ? []
    : filterByCapability(navItems, hasCap);
  const visibleBottomItems = capabilitiesLoading
    ? []
    : filterByCapability(bottomNavItems, hasCap);
  const canOpenSettings = !capabilitiesLoading && hasCap("menu.settings");
  const totalUnread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();
  // Proposals waiting for a decision (0 unless the person can review them).
  const { count: pendingApprovals } = useApprovalsCount();
  // Tickets where someone asked this person for a response and it is still open
  // (migration 095). Nothing is fetched for a role that cannot open Tickets.
  const { count: ticketsWaiting } = useMyTicketMentions(!capabilitiesLoading && hasCap("menu.tickets"));

  // Only matters at lg+ — mobile always shows the full drawer regardless
  // of `pinned`. Tracked via matchMedia rather than a CSS-only approach
  // so collapsed-state text can be conditionally rendered (not just
  // hidden), avoiding layout-shifted icon rows on the mobile drawer.
  // Starts `false` so the very first render (SSR + initial hydration)
  // always shows the expanded sidebar — matches the server-rendered
  // markup and avoids a hydration mismatch.
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Transient hover-expand — only reachable when collapsed on desktop.
  const [hovered, setHovered] = useState(false);
  const collapsed = isDesktop && !pinned && !hovered;
  const expanded = !collapsed;
  // Only surface the account-name strip when it actually carries
  // information. A solo user's personal account is named after them
  // (the 017 signup trigger seeds it from `full_name`), so showing it
  // here would just duplicate the user name in the footer below. Once
  // the account is renamed or the user joins a shared account, the
  // name diverges and the strip becomes meaningful — that's the signal
  // we gate on. Wait for the profile fetch to settle first, otherwise
  // the strip flashes in once the row resolves (a layout jump).
  const showAccountStrip =
    !profileLoading &&
    !!account?.name &&
    account.name !== profile?.full_name;

  // Close the drawer when route changes — users opened it to navigate,
  // so once they pick a destination the drawer should get out of the way.
  useEffect(() => {
    onClose?.();
    // Only pathname drives this — onClose identity doesn't need to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the sidebar isn't positioned there.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop — only exists on mobile and only when open. Clicking
          it closes the drawer. Hidden from lg+ since the sidebar is
          part of the main flex row there. */}
      <button
        type="button"
        aria-label={t("closeMenu")}
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-background/70 backdrop-blur-sm transition-opacity lg:hidden",
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      />

      <aside
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          // Always fixed/overlay — even at lg+, so hover-expand floats
          // over page content instead of reflowing it. dashboard-shell's
          // spacer div reserves this width in the flex layout.
          "fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col border-r border-border bg-card",
          "transition-transform duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          "lg:translate-x-0 lg:shadow-lg lg:transition-[width] lg:duration-200 lg:will-change-[width]",
          collapsed ? "lg:w-16" : "lg:w-60",
        )}
        aria-label={t("primaryNav")}
      >
        {/* Logo row. On mobile we put a close button here; on desktop a
            pin/collapse toggle instead (always-visible sidebar, nothing
            to close). */}
        <div
          className={cn(
            "flex h-14 shrink-0 items-center gap-2 border-b border-border px-4",
            collapsed ? "lg:justify-center lg:px-0" : "justify-between",
          )}
        >
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <MessageSquare className="h-4 w-4" />
            </div>
            {expanded && (
              <span className="text-sm font-semibold text-foreground">
                {t("title")}
              </span>
            )}
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("closeMenu")}
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
          {onTogglePinned && expanded && (
            <button
              type="button"
              onClick={onTogglePinned}
              aria-label={pinned ? t("collapseSidebar") : t("pinSidebar")}
              title={pinned ? t("collapseSidebar") : t("pinSidebar")}
              className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:flex"
            >
              {pinned ? (
                <ChevronsLeft className="h-4 w-4" />
              ) : (
                <ChevronsRight className="h-4 w-4" />
              )}
            </button>
          )}
        </div>

        {/* Main navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="flex flex-col gap-1">
            {visibleNavItems.map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href !== "/dashboard" && pathname.startsWith(item.href));

              const showUnreadDot =
                item.href === "/inbox" && totalUnread > 0 && !isActive;

              // Unlike the inbox dot, the notifications count stays visible
              // even while the page is active — it reflects unread state
              // (cleared by marking notifications read), not "currently
              // viewing this section".
              const showNotificationBadge =
                item.href === "/notifications" && unreadNotifications > 0;

              // Same round bubble for the Tickets item: how many tickets wait on
              // this person's response. Visible on the page too (it clears when
              // they answer, not when they look).
              const showTicketsBadge = item.href === "/tickets" && ticketsWaiting > 0;

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    title={collapsed ? t(item.labelKey as string) : undefined}
                    className={cn(
                      // Taller on mobile so fingers can hit the row reliably (≥44px).
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                      collapsed && "lg:justify-center lg:px-0",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    {expanded && (
                      <>
                        <span className="flex-1">{t(item.labelKey as string)}</span>
                        {item.beta && (
                          <span
                            aria-label={t("beta")}
                            className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300"
                          >
                            {t("beta")}
                          </span>
                        )}
                      </>
                    )}
                    {showUnreadDot && (
                      <span
                        aria-label={t("unreadConversations", { count: totalUnread })}
                        className="relative flex h-2 w-2 shrink-0"
                      >
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                      </span>
                    )}
                    {showNotificationBadge && (
                      <span
                        aria-label={t("unreadNotifications", { count: unreadNotifications })}
                        className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
                      >
                        {unreadNotifications > 9 ? "9+" : unreadNotifications}
                      </span>
                    )}
                    {showTicketsBadge && <TicketsWaitingBadge count={ticketsWaiting} />}
                  </Link>
                </li>
              );
            })}
          </ul>

          {visibleBottomItems.length > 0 && visibleNavItems.length > 0 ? (
            <div className="my-4 border-t border-border" />
          ) : null}

          <ul className="flex flex-col gap-1">
            {visibleBottomItems.map((item) => {
              const isActive = pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    title={collapsed ? t(item.labelKey as string) : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                      collapsed && "lg:justify-center lg:px-0",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    {expanded && (
                      <span className="flex-1">{t(item.labelKey as string)}</span>
                    )}
                    {item.href === "/settings" && pendingApprovals > 0 && (
                      <span
                        aria-label={t("pendingApprovals", { count: pendingApprovals })}
                        className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white"
                      >
                        {badgeLabel(pendingApprovals)}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* User section */}
        <div className="shrink-0 border-t border-border p-3">
          {/* Account name display — surfaced only when the account
              name differs from the user's own name (see
              `showAccountStrip`). For a default solo account the two
              match, so we hide it to avoid duplicating the user name
              below; for renamed or shared accounts it tells the user
              which account they're acting in. Also hidden while
              collapsed — no room for a text strip on an icon rail. */}
          {showAccountStrip && account?.name && expanded ? (
            <div className="mb-2 flex items-center gap-2 px-3 text-xs text-muted-foreground">
              <UsersRound className="size-3.5 shrink-0" />
              {/* `title=` exposes the full name on hover when it
                  gets truncated (long account names + narrow
                  sidebars). Cheap a11y win. */}
              <span className="truncate" title={account.name}>
                {account.name}
              </span>
              {accountRole ? (
                // Always render the chip — owners used to be
                // invisible here, which made them indistinguishable
                // from admins at a glance. Now everyone sees their
                // role (with a colour cue) regardless of tier.
                (() => {
                  const meta = ROLE_CHIP[accountRole];
                  const Icon = meta.icon;
                  return (
                    <span
                      className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${meta.className}`}
                    >
                      <Icon className="size-3" />
                      {t(meta.labelKey as string)}
                    </span>
                  );
                })()
              ) : null}
            </div>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              title={collapsed ? (profile?.full_name ?? t("defaultUser")) : undefined}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:outline-none data-popup-open:bg-muted/60",
                collapsed && "lg:justify-center lg:px-0",
              )}
            >
              <Avatar className="size-8 shrink-0">
                {profile?.avatar_url ? (
                  <AvatarImage
                    src={profile.avatar_url}
                    alt={profile.full_name ?? t("defaultAvatar")}
                  />
                ) : null}
                <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ??
                    profile?.email?.charAt(0)?.toUpperCase() ??
                    "U"}
                </AvatarFallback>
              </Avatar>
              {expanded && (
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {profile?.full_name ?? t("defaultUser")}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {profile?.email ?? ""}
                  </p>
                </div>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="top"
              sideOffset={6}
              className="min-w-56 bg-popover text-popover-foreground ring-border"
            >
              {/* Both links land on the Settings page, which is guarded by
                  menu.settings: hide them when the person has no access. */}
              {canOpenSettings ? (
                <>
                  <DropdownMenuItem
                    render={
                      <Link
                        href="/settings?tab=profile"
                        onClick={onClose}
                        className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                      />
                    }
                  >
                    <User className="size-4" />
                    {t("menuProfile")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    render={
                      <Link
                        href="/settings?tab=whatsapp"
                        onClick={onClose}
                        className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                      />
                    }
                  >
                    <Settings className="size-4" />
                    {t("menuSettings")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="bg-border" />
                </>
              ) : null}
              <DropdownMenuItem
                onClick={signOut}
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <LogOut className="size-4" />
                {t("menuSignOut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  );
}
