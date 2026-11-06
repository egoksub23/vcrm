// The Setup guide: the steps from an empty school to a live one, and whether each is done. Pure, so "done" means the same thing everywhere.

export type SetupStepKey = "template" | "roles" | "rules" | "packs" | "form" | "portal";

export interface SetupStep {
  key: SetupStepKey;
  done: boolean;
  /** A short fact for the row, for example "6 roles, 9 people". Rendered by the page with its own words. */
  facts: Record<string, string | number>;
  /** Where the step is done. */
  href: string;
}

export function buildSetupSteps(input: {
  templateName: string | null;
  roles: { kind: string; memberCount: number; warnings: number }[];
  contactCount: number;
  rulesOn: number;
  packNames: string[];
  /** Keys the coach portal can use: live ones that have not been revoked. */
  liveKeys?: number;
  /** The version of the school's own published report form, if it has one. */
  formVersion?: number | null;
}): SetupStep[] {
  const fixed = input.roles.filter((r) => r.kind === "fixed");
  const staffed = fixed.filter((r) => r.memberCount > 0).length;
  return [
    { key: "template", done: input.templateName !== null, facts: { name: input.templateName ?? "" }, href: "/settings?tab=incidents" },
    // Done when there is at least one person and at least one role has someone in it: enough for a first rule to reach somebody.
    { key: "roles", done: input.contactCount > 0 && staffed > 0, facts: { roles: fixed.length, staffed, people: input.contactCount }, href: "/incidents/setup/roles" },
    { key: "rules", done: input.rulesOn > 0, facts: { count: input.rulesOn }, href: "/incidents/setup/rules" },
    { key: "packs", done: input.packNames.length > 0, facts: { count: input.packNames.length, names: input.packNames.join(", ") }, href: "/settings?tab=incidents" },
    // The built-in form works, so this step is "done" when the school has looked at it or published its own; it never blocks going live.
    { key: "form", done: input.formVersion != null, facts: { version: input.formVersion ?? 0 }, href: "/incidents/setup/form" },
    { key: "portal", done: (input.liveKeys ?? 0) > 0, facts: { count: input.liveKeys ?? 0 }, href: "/incidents/setup/portal" },
  ];
}
