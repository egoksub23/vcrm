"use client";

// ============================================================
// Doc Sign editor: the email address of each person a role stands for (display only, never saved with the roles). Two people can share a name, so
// the editor shows the address next to the name wherever a role is shown: the quick "Add a signature block" buttons, the "Filled in by" choice and
// the block itself. The sending workflow supplies it (a role key to an address); without it nothing changes.
// ============================================================

import { createContext, useContext } from "react";

export type RoleEmails = Readonly<Record<string, string>>;

const NONE: RoleEmails = {};
const RoleEmailsContext = createContext<RoleEmails>(NONE);

export const RoleEmailsProvider = RoleEmailsContext.Provider;
export const useRoleEmails = (): RoleEmails => useContext(RoleEmailsContext);
