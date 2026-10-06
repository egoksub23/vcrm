// The keys of the lists every workspace starts with (see system-lists.ts, which holds their content). Kept apart from that
// file so that code which only needs the keys does not carry the content (MSIC alone is ~200 KB); a test keeps the two equal.

export const SYSTEM_LIST_KEYS = ["states_my", "countries", "banks_my", "company_id_types", "einvoice_phases", "tax_types", "msic"] as const;
export type SystemListKey = (typeof SYSTEM_LIST_KEYS)[number];

export const isSystemListKey = (key: string): key is SystemListKey => (SYSTEM_LIST_KEYS as readonly string[]).includes(key);
