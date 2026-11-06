import Link from "next/link";

import { cn } from "@/lib/utils";
import type { NavChild } from "./nav-items";

/**
 * Is this child the page the person is on?
 *  - "All incidents" is /incidents itself: it is current on that path and on an incident's own page (/incidents/<id>), not on the other sections.
 *  - A deeper path belongs to the most specific sibling: /incidents/setup/roles is Roles, not Setup guide.
 *  - A link into Settings (it carries a query) is never "current" here: on the Settings page the Settings row is the active one.
 */
export function isChildActive(child: Pick<NavChild, "href">, pathname: string, siblings: readonly Pick<NavChild, "href">[] = []): boolean {
  const [path, query] = child.href.split("?");
  if (query) return false;
  if (pathname === path) return true;
  if (!pathname.startsWith(`${path}/`)) return false;
  const moreSpecific = siblings.some(
    (s) => s.href !== child.href && !s.href.includes("?") && s.href.length > path.length && (pathname === s.href || pathname.startsWith(`${s.href}/`)),
  );
  if (moreSpecific) return false;
  if (path === "/incidents") return !/^\/incidents\/(overview|tasks|setup)(\/|$)/.test(pathname);
  return true;
}

export function NavChildren({
  items,
  pathname,
  label,
  setupLabel,
}: {
  items: NavChild[];
  pathname: string;
  label: (key: string) => string;
  setupLabel: string;
}) {
  const main = items.filter((c) => !c.setup);
  const setup = items.filter((c) => c.setup);
  const row = (c: NavChild) => {
    const active = isChildActive(c, pathname, items);
    return (
      <li key={c.href}>
        <Link
          href={c.href}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex items-center gap-2.5 rounded-md py-1.5 pr-2 pl-9 text-[13px] transition-colors",
            active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <c.icon className="size-3.5 shrink-0" />
          <span className="truncate">{label(c.labelKey)}</span>
        </Link>
      </li>
    );
  };
  return (
    <div className="mt-1 mb-1">
      <ul className="flex flex-col gap-0.5">{main.map(row)}</ul>
      {setup.length > 0 ? (
        <>
          <p className="mt-2 mb-1 pl-9 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{setupLabel}</p>
          <ul className="flex flex-col gap-0.5">{setup.map(row)}</ul>
        </>
      ) : null}
    </div>
  );
}
