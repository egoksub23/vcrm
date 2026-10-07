import { BarChart3, Bell, Bot, BookMarked, BookOpen, Building2, FileSignature, GitBranch, LayoutDashboard, MessageCircle, MessageSquare, Radio, Settings, ShieldAlert, Ticket, Users, Workflow, Zap } from "lucide-react";

// The sidebar's rows, in order. A plain module (no hooks), so the order and the capability of each row can be tested.

export interface NavItem {
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

export const navItems: NavItem[] = [
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
export const bottomNavItems: NavItem[] = [
  { href: "/help", labelKey: "userGuide", icon: BookMarked },
  { href: "/settings", labelKey: "settings", icon: Settings, capability: "menu.settings" },
  { href: "/sembang", labelKey: "sembang", icon: MessageCircle, beta: true, capability: "menu.sembang" },
  // Incident Reporting: internal, next to Sembang, not a customer-facing
  // tool — open to every role (anyone can raise one); per-incident
  // visibility is enforced separately (migration 116).
  { href: "/incidents", labelKey: "incidents", icon: ShieldAlert, capability: "menu.incidents" },
  // Secure Sign (the e-signing module): directly below Incidents. Same capability as before; the page and the feature flag still gate it.
  { href: "/sign", labelKey: "sign", icon: FileSignature, capability: "menu.sign" },
];

// Operator console (migration 132). Not capability-gated: platform admins
// are a separate population from account roles, so it is appended below
// only for them. The page and the /api/platform routes enforce it again.
export const platformNavItem: NavItem = { href: "/platform", labelKey: "platform", icon: Building2 };
