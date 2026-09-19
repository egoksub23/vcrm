"use client";

import { useTranslations } from "next-intl";
import { Mail, MessageCircleMore, MessagesSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import type { InboxTab } from "@/lib/inbox/channel-scope";

const TABS: { key: InboxTab; label: "tabChats" | "tabEmails" | "tabComments" }[] = [
  { key: "chats", label: "tabChats" },
  { key: "emails", label: "tabEmails" },
  { key: "comments", label: "tabComments" },
];

/**
 * The Chats | Emails | Comments switch at the top of the inbox's left
 * column. Shared by the conversation list and the comments list so it
 * looks and behaves the same on every tab. Each bubble is what still needs
 * attention on that tab.
 */
export function InboxTabBar({
  tab,
  onTabClick,
  unread,
}: {
  tab: InboxTab;
  onTabClick: (tab: InboxTab) => void;
  unread: Record<InboxTab, number>;
}) {
  const t = useTranslations("Inbox.conversationList");
  return (
    <div role="tablist" className="flex shrink-0 border-b border-border">
      {TABS.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          onClick={() => onTabClick(key)}
          className={cn(
            "-mb-px flex flex-1 items-center justify-center gap-1.5 border-b-2 px-1.5 py-3 text-sm transition-colors",
            tab === key
              ? "border-primary font-medium text-foreground"
              : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          )}
        >
          {key === "chats" ? (
            <MessagesSquare className="h-4 w-4" />
          ) : key === "emails" ? (
            <Mail className="h-4 w-4" />
          ) : (
            <MessageCircleMore className="h-4 w-4" />
          )}
          {t(label)}
          <span
            aria-label={t("tabUnreadAria", { count: unread[key] })}
            className={cn(
              "flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium",
              unread[key] > 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
            )}
          >
            {unread[key]}
          </span>
        </button>
      ))}
    </div>
  );
}
