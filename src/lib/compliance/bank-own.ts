// ============================================================
// Compliance requests (migration 186): "does the refund bank account belong to the Vircle account holder?". The answer and the two things staff are told
// because of it. Pure; browser-safe (the staff screens use the same rules the server wrote the flag with).
//
//   bank_account_is_own   the parent's answer (a yesno field of the closure and withdrawal types; asked on the public forms and the personal closure form).
//   name_differs          a flag the SERVER writes next to it, never typed by anybody and never shown to the parent: the answer is Yes but the bank holder
//                         name still differs from the account holder name once the usual Malaysian naming forms are set aside (public/names.ts). It holds
//                         no name, only true or false. It is information for the officer ("check before paying"); it never blocks anything.
//   authorization_letter  the file the parent adds when the answer is No; shown to staff as "payout to a third party: letter on file".
//
// A case made before migration 186 simply lacks the answer: the screen then says "Not asked (older form)" and does not guess.
// ============================================================

import { holderNameDiffers } from "./public/names";

export const BANK_OWN_KEY = "bank_account_is_own";
export const NAME_DIFFERS_KEY = "name_differs";
export const LETTER_KEY = "authorization_letter";

/** What the case says about whose bank account the payout goes to. */
export type BankOwner = "own" | "third_party" | "not_asked";

export function bankOwner(data: Record<string, unknown> | null | undefined): BankOwner {
  const v = data?.[BANK_OWN_KEY];
  return v === true ? "own" : v === false ? "third_party" : "not_asked";
}

/** The flag the server stores with a new answer, or null when the question was not answered or there is no bank holder name yet (nothing is written then). */
export function nameDiffersFlag(
  data: Record<string, unknown>,
  sensitive: Record<string, unknown>,
  accountHolderName: string | null | undefined,
): boolean | null {
  const own = data[BANK_OWN_KEY];
  if (typeof own !== "boolean") return null;
  const holder = sensitive.bank_account_holder;
  if (typeof holder !== "string" || holder.trim() === "") return null; // nothing to compare yet: no claim either way
  return holderNameDiffers(own, accountHolderName, holder);
}

/** What the staff screen says about the payout, for a case's stored answers. `nameDiffers` is true only for an own account whose names differ. */
export function bankFlags(data: Record<string, unknown> | null | undefined): { owner: BankOwner; nameDiffers: boolean } {
  const owner = bankOwner(data);
  return { owner, nameDiffers: owner === "own" && data?.[NAME_DIFFERS_KEY] === true };
}

/** One line of what the staff screen says about the payout. */
export type BankFlag =
  /** The parent said the account is theirs, but the bank holder name differs from the account holder name: check before paying. */
  | { kind: "name_differs" }
  /** The payout goes to somebody else's account; the authorization letter is on file (`file`), or missing (null). */
  | { kind: "third_party"; file: { id: string; name: string } | null };

/** The flags to show for a case: its stored answers and the files recorded against it. Nothing for an older case that was never asked. */
export function bankFlagList(data: Record<string, unknown> | null | undefined, files: readonly { id: string; name: string; fieldKey: string | null }[]): BankFlag[] {
  const { owner, nameDiffers } = bankFlags(data);
  const out: BankFlag[] = [];
  if (nameDiffers) out.push({ kind: "name_differs" });
  if (owner === "third_party") {
    const letter = files.find((f) => f.fieldKey === LETTER_KEY);
    out.push({ kind: "third_party", file: letter ? { id: letter.id, name: letter.name } : null });
  }
  return out;
}
