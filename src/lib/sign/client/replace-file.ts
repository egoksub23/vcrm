// ============================================================
// Doc Sign, browser side: replacing the file of a draft (F-77). The two calls (find out, then do it) and the words for a field that was
// flagged. The decision itself (which fields keep their place) is lib/sign/replace-file.ts, run by the server.
// ============================================================

import { signRequest } from "./api";
import type { FlagReason } from "../replace-file";
import type { ReplaceResult } from "../service/replace-file";
import type { PlacedField } from "../pdf/types";

export type { FlagReason } from "../replace-file";
export type ReplaceAnswer = Pick<ReplaceResult, "dryRun" | "kept" | "flagged" | "oldPageCount" | "newPageCount" | "pageCountChanged" | "converted"> & { fields: PlacedField[] };

/** `dryRun`: only find out what would happen. Otherwise the file is replaced. */
export async function postReplace(documentId: string, file: File, dryRun: boolean): Promise<ReplaceAnswer> {
  const form = new FormData();
  form.append("file", file, file.name);
  if (dryRun) form.append("dryRun", "1");
  const res = await signRequest<{ result: ReplaceAnswer }>(`/api/sign/documents/${documentId}/replace-file`, { method: "POST", form });
  return res.result;
}

/** The message key (under `Sign.editor.replaceFile.reason`) for each reason a field was flagged. */
export const reasonKey = (reason: FlagReason): string => `reason.${reason}`;

/** How a flagged field is named to the sender: its label when it has one, otherwise what kind of field it is (the caller words the type). */
export function fieldName(f: Pick<PlacedField, "label" | "type" | "key"> | undefined, typeWord: (type: string) => string, fallback: string): string {
  if (!f) return fallback;
  const label = f.label?.trim();
  return label || typeWord(f.type);
}
