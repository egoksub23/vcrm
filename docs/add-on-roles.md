# Add-on roles

A person has **one base role** (Owner, Admin, Agent or Viewer, and the custom role they may already hold) and may be given **any number of add-on roles** on top. An add-on role is a named set of extra permissions (for example "KYC reviewer": `menu.kyc`, `kyc.view`, `kyc.decide`). What a person can do is their base role's permissions **plus** every add-on's. **Add-only**: nothing in an add-on takes a permission away.

Migration **191**. Apply it **before** the code that reads its tables is deployed.

## Rules (all enforced in the database)

| Rule | Where |
|---|---|
| The base role stays the rank backbone (who may change whom, every existing row-level policy). An add-on never changes a person's rank. | unchanged |
| An add-on cannot lift a person above their base tier: a permission is effective only when the base tier is at least that permission's `min_grant_role`. A Viewer is never given a permission that writes data. | `addon_grants_capability()` and `addonCapabilitiesFor()` |
| Nobody hands out more than they hold: a permission goes into an add-on, and an add-on is given to someone (or carried by an invitation), only by a person who holds every permission involved. Taking one away needs none. | `create_addon_role`, `update_addon_role`, `set_member_addon_roles`, `enforce_invitation_addons` |
| Making, editing and deleting an add-on needs `roles.manage` in that workspace. | the three functions |
| Giving add-ons needs `members.change-role` and an admin rank, and a target strictly below the caller; never the owner (who holds everything), never oneself, only this workspace's roles. | `set_member_addon_roles` |
| Every change is in the audit trail (a role created, renamed, deleted; its permissions changed; a member's add-ons changed), with names and never a secret. | `log_audit` |
| A member who leaves a workspace loses its add-ons. Accepting an invitation gives the add-ons it carried that still exist. | trigger on `profiles.account_id`, `attach_user_to_invited_account` |

## One meaning of "holds a permission"

`person_has_capability(account, user, capability)` is the one place that answers it: the base role (or custom role) as before, **or** an add-on. These all use it, so a permission means the same everywhere:

- `has_capability` (the row-level policies and the functions that check the caller),
- `capabilities_for_current_user` (the list the app loads),
- `capability_account_ids` (the hot function ~30 write policies use; it inlines the same rule for query-plan reasons),
- `compliance_user_can` and `compliance_holders`,
- who is notified: `approvals_notify_reviewers`, `notify_incident_raised`, `incident_escalation_recipient_ids`.

The app side is `loadCapabilities` in `src/lib/auth/account.ts`, which reads the person's add-ons and applies `withAddonCapabilities` (`src/lib/auth/capabilities.ts`), the TypeScript mirror of `addon_grants_capability`.

`supabase/ci/verify-191-addon-roles.sql` proves, for an owner, an admin, an agent with add-ons and a viewer, that `has_capability`, `capabilities_for_current_user`, `capability_account_ids` and `compliance_user_can` **agree on every permission**. Run it rolled back against production (with 191's text in front until it is applied) and expect `ROLLBACK-OK`.

### Not changed (and why)

Two older functions still read a person's **base role only**, so an add-on does not affect them: the ticket SLA alert (`086`, which goes to owners and admins by design) and the knowledge-draft counts that decide whether an article needs approval (`084`, `088`). The notification helper `loadCapabilityRecipients` (`src/lib/auth/capability-recipients.ts`, used by the AI budget alert, the certificate watch and a few others) also ignores custom roles today; it is a notification list, not a security boundary.

## Tables

`account_addon_roles` (name, description), `account_addon_role_capabilities` (a row = the add-on gives that capability; there is no "denied" row), `member_addon_roles` (who holds which). Members of the workspace may read them; **nobody writes them directly** (only the functions). `account_invitations.addon_role_ids` carries an invitation's add-ons.

## API

| Route | Permission | |
|---|---|---|
| `GET /api/account/roles/addons` | any member | the workspace's add-ons with how many people hold each and the lowest base role at which every permission in it applies; the permission keys only for people who manage roles |
| `POST /api/account/roles/addons` | `roles.manage` | `{ name, description?, capabilities? }` |
| `PATCH /api/account/roles/addons/{id}` | `roles.manage` | `{ name?, description?, capabilities? }`; `capabilities` is the whole new set |
| `DELETE /api/account/roles/addons/{id}` | `roles.manage` | everyone who held it loses what it gave |
| `PUT /api/account/members/{userId}/addons` | `members.change-role` | `{ addonRoleIds: [...] }`, the whole list for that person |
| `POST /api/account/invitations` | `members.invite` | accepts `addonRoleIds` |

`GET /api/account/members` also returns each person's `addon_roles` and, for people who hold some, `effectiveCapabilityCounts[userId]` (the base role's count is otherwise what the member panel shows).

## Screens

Settings → **Roles & permissions** → **Add-on roles** (list on the left, editor on the right); Settings → **Team**: a person's panel has **Add-on roles** (saved as they are picked, like Teams) and the list shows them beside the role; the invite dialog has **Add-on roles**. An add-on holding a permission that needs more than a Viewer says so (`Needs Agent or above`), and the member panel says when some of an add-on's permissions do not apply at that person's base role.
