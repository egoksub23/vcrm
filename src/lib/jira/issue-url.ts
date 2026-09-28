// ============================================================
// Recognizing a Jira Cloud issue URL pasted into a Sembang message
// ("https://vircle.atlassian.net/browse/VC-1738"), so the message-send
// route can unfurl it into a live status/priority/assignee card
// (migration 119) instead of falling back to a generic OpenGraph
// scrape of the Jira page (which requires a login to render anything
// useful anyway).
//
// Deliberately keyed on *.atlassian.net/browse/<KEY> only — Jira Cloud's
// own URL shape, matching how every other Jira URL in this codebase is
// built (see issueUrlOf() in src/lib/tickets/jira-ui.ts). A self-hosted
// Jira Server/Data Center instance uses a different path shape
// (/browse/<KEY> under an arbitrary domain) and is out of scope: Vircel's
// Jira integration (src/lib/jira/oauth.ts) is Cloud-only.
// ============================================================

const JIRA_BROWSE_RE = /^https?:\/\/[a-z0-9-]+\.atlassian\.net\/browse\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#]|$)/i;

/** The issue key ("VC-1738") if `url` looks like a Jira Cloud issue link,
 *  else `null`. Pure — does not check whether the account is even
 *  connected to that (or any) Jira site; the caller does that. */
export function matchJiraIssueKey(url: string): string | null {
  const m = JIRA_BROWSE_RE.exec(url.trim());
  return m ? m[1].toUpperCase() : null;
}
