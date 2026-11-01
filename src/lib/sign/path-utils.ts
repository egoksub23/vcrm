// Pure path/name helpers — no storage dependency, safe to import in client components.

export type FileKind = "source" | "base" | "annex" | "upload" | "final" | "certificate";

/** A name safe to keep in a storage path. */
export function safeFileName(name: string, fallback = "file"): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80);
  return cleaned || fallback;
}

export function documentPath(accountId: string, documentId: string, kind: FileKind, name: string): string {
  return `account-${accountId}/${documentId}/${kind}/${name}`;
}

export function templatePath(accountId: string, templateId: string, name: string): string {
  return `account-${accountId}/templates/${templateId}/${name}`;
}

/** The workspace folder a path must sit in; used to refuse a stored path that points somewhere else. */
export function belongsToAccount(path: string, accountId: string): boolean {
  return path.startsWith(`account-${accountId}/`) && !path.includes("..");
}
