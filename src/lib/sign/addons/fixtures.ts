// Test fixtures for the add-ons: the shared option lists a workspace starts with, as the database function sign_seed_option_lists would
// copy them in (an add-on's form names the lists, and a template version stores them copied in). Imported only by tests.

import type { FormDefinition } from "../forms/types";
import { resolveFormLists } from "../forms/lists";
import { SYSTEM_LISTS } from "../lists/system-lists";
import { catalogueOf, type ListItem, type OptionListRow } from "../lists/types";
import type { FakeDb } from "../service/fake-db";

/** The rows `sign_seed_option_lists` makes for a workspace: every shipped list it does not have yet. */
export function systemListRows(account: string, have: ReadonlySet<string> = new Set()): OptionListRow[] {
  return SYSTEM_LISTS.filter((l) => !have.has(l.key)).map(
    (l) =>
      ({
        id: `list-${account.slice(0, 4)}-${l.key}`,
        account_id: account,
        key: l.key,
        name: l.name,
        description: l.description,
        kind: l.kind,
        items: JSON.parse(JSON.stringify(l.items)) as ListItem[],
        item_count: l.items.length,
        is_system: true,
        version: 1,
        archived: false,
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
      }) satisfies OptionListRow,
  );
}

/** Make the fake database answer `sign_seed_option_lists`, and seed the lists now when `now` is true. */
export function withSystemLists(db: FakeDb, account: string, now = false): void {
  const seed = () => {
    const have = new Set(db.rows("sign_option_lists").filter((r) => r.account_id === account).map((r) => String(r.key)));
    const rows = systemListRows(account, have);
    db.seed("sign_option_lists", rows as unknown as Record<string, unknown>[]);
    return rows.length;
  };
  db.rpcHandlers.sign_seed_option_lists = async () => ({ data: seed(), error: null });
  if (now) seed();
}

/** A form with every list it names copied in, as it is stored on a template version and carried by a document. */
export function resolvedWithSystemLists(form: FormDefinition, account = "acct"): FormDefinition {
  const out = resolveFormLists(form, catalogueOf(systemListRows(account)), { strict: true });
  if (out.problems.length) throw new Error(`the form names lists that do not resolve: ${JSON.stringify(out.problems)}`);
  return out.form;
}
