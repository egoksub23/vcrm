"use client";

// The unfurled-link card — a thumbnail + domain/title/description strip
// for a URL. Originally inline in message-row.tsx (the in-message
// unfurl); extracted so the Links and Bookmarks tabs (channel-resources-
// panel.tsx) can show the same card instead of a bare URL string.

interface LinkPreviewCardProps {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  domain: string | null;
  className?: string;
}

export function LinkPreviewCard({ url, title, description, imageUrl, domain, className }: LinkPreviewCardProps) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={
        "flex w-fit max-w-sm items-stretch gap-3 overflow-hidden rounded-lg border border-border bg-muted/30 hover:bg-muted/50" +
        (className ? ` ${className}` : "")
      }
    >
      {imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- arbitrary external domain, same as PersonAvatar
        <img
          src={imageUrl}
          alt=""
          className="h-20 w-20 shrink-0 object-cover"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      )}
      <div className="min-w-0 flex-1 py-2 pr-3">
        {domain && <p className="truncate text-[11px] text-muted-foreground">{domain}</p>}
        {title && <p className="truncate text-sm font-medium text-foreground">{title}</p>}
        {description && <p className="line-clamp-2 text-xs text-muted-foreground">{description}</p>}
        {!title && !description && <p className="truncate text-sm text-primary">{url}</p>}
      </div>
    </a>
  );
}
