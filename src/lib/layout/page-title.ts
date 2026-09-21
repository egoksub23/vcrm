/**
 * Maps a dashboard pathname to the Header i18n key for its title.
 *
 * Longest-prefix matching on whole path segments, so nested routes
 * (/knowledge/new, /tickets/123, /help/inbox/foo) keep their section title and
 * "/helpful" never matches "/help". Unknown routes fall back to "dashboard".
 */
export const PAGE_TITLE_KEYS: Record<string, string> = {
  "/dashboard": "dashboard",
  "/inbox": "inbox",
  "/notifications": "notifications",
  "/contacts": "contacts",
  "/pipelines": "pipelines",
  "/broadcasts": "broadcasts",
  "/tickets": "tickets",
  "/automations": "automations",
  "/flows": "flows",
  "/knowledge": "knowledge",
  "/agents": "aiAgents",
  "/reports": "reports",
  "/settings": "settings",
  "/help": "userGuide",
};

export function getPageTitleKey(pathname: string | null | undefined): string {
  if (!pathname) return "dashboard";
  // Drop any query string or hash, and a trailing slash.
  const clean = pathname.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  let best: string | null = null;
  for (const path of Object.keys(PAGE_TITLE_KEYS)) {
    if (clean === path || clean.startsWith(`${path}/`)) {
      if (best === null || path.length > best.length) best = path;
    }
  }
  return best ? PAGE_TITLE_KEYS[best] : "dashboard";
}
