"use client";

import { useAuth, useCapability } from "@/hooks/use-auth";
import { LEGACY_CAN_ACTIONS } from "@/lib/auth/capabilities";
import {
  canDeleteAccount,
  canTransferOwnership,
  canViewOnly,
} from "@/lib/auth/roles";

export { useCapability };

/**
 * Typed action keys for `useCan`. The closed list lets the compiler
 * catch typos at every call site.
 *
 * Three of them are capabilities in disguise (`LEGACY_CAN_ACTIONS`):
 * `manage-members` = members.change-role, `edit-settings` =
 * settings.workspace, `send-messages` = messages.send. New code should
 * call `useCapability(...)` with the specific capability instead. The
 * other three are role facts that stay outside the matrix.
 */
export type CanAction =
  | "manage-members"
  | "edit-settings"
  | "send-messages"
  | "view-only"
  | "delete-account"
  | "transfer-ownership";

/**
 * Inline alternative to `<RequireRole>` for places that need a
 * boolean rather than a render conditional.
 *
 * Fails closed: false while capabilities / the profile are loading and
 * without a role, so transient "you can!" flashes never appear to
 * under-privileged users.
 *
 * Example:
 *   const canEdit = useCan("edit-settings");
 *   <Button disabled={!canEdit} title={canEdit ? "Save" : "Read-only"} />
 */
export function useCan(action: CanAction): boolean {
  const { profileLoading, accountRole } = useAuth();
  // Hooks may not be conditional: resolve the capability (or none) first.
  const mapped = LEGACY_CAN_ACTIONS[action] ?? null;
  const hasCapability = useCapability(mapped ?? "");
  if (profileLoading || !accountRole) return false;

  switch (action) {
    case "manage-members":
    case "edit-settings":
    case "send-messages":
      return mapped !== null && hasCapability;
    case "view-only":
      return canViewOnly(accountRole);
    case "delete-account":
      return canDeleteAccount(accountRole);
    case "transfer-ownership":
      return canTransferOwnership(accountRole);
    default: {
      // Exhaustiveness check: a new `CanAction` without a case fails
      // the typecheck because `action` narrows to `never` here.
      const _exhaustive: never = action;
      throw new Error(`Unknown CanAction: ${String(_exhaustive)}`);
    }
  }
}
