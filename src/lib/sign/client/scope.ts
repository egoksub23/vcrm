// ============================================================
// Doc Sign, signing page: what a call is about. A link is a token; an envelope's link (migration 171) serves several documents, so a call
// that is about one of them also names it. The page carries this as one string, its SCOPE: the token alone for a document on its own, or
// `<token>@<document id>`. Every call of the page takes the scope, and the address it builds carries `?doc=` only when there is a document
// to name (the server answers a document the person is not a signer of exactly as it answers a bad link). Pure.
// ============================================================

export interface SplitScope {
  token: string;
  /** The document of the envelope the call is about; null for a document on its own, or a call about the whole link (the code). */
  documentId: string | null;
}

export const scopeOf = (token: string, documentId?: string | null): string => (documentId ? `${token}@${documentId}` : token);

export function splitScope(scope: string): SplitScope {
  const at = scope.indexOf("@");
  return at < 0 ? { token: scope, documentId: null } : { token: scope.slice(0, at), documentId: scope.slice(at + 1) || null };
}

/** The route's address on a link: `/api/sign/public/<token>` plus the path. `withDocument` false is for the calls about the whole link (the code). */
export function publicPath(scope: string, path = "", opts: { withDocument?: boolean; query?: string } = {}): string {
  const { token, documentId } = splitScope(scope);
  const params = [opts.withDocument === false || !documentId ? "" : `doc=${encodeURIComponent(documentId)}`, opts.query ?? ""].filter(Boolean).join("&");
  return `/api/sign/public/${token}${path}${params ? `?${params}` : ""}`;
}
