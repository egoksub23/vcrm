// ============================================================
// Doc Sign option lists, browser side: the calls the Lists screen and the form builder make. The routes are under
// /api/sign/lists (see src/app/api/sign/lists/**). Every failure is a SignApiError carrying the route's code.
// ============================================================

import type { ImportResult, ListItem, ListResult, ListsResult, OptionListRow, OptionListSummary } from "../lists/types";
import { signRequest } from "./api";

export const loadLists = async (signal?: AbortSignal): Promise<OptionListSummary[]> => (await signRequest<ListsResult>("/api/sign/lists", { signal })).lists;

export const loadList = (key: string, signal?: AbortSignal): Promise<ListResult> => signRequest<ListResult>(`/api/sign/lists/${encodeURIComponent(key)}`, { signal });

export const createList = async (input: { name: string; description?: string | null; items?: ListItem[] }): Promise<OptionListRow> => (await signRequest<{ list: OptionListRow }>("/api/sign/lists", { json: input })).list;

export interface ListPatchBody {
  name?: string;
  description?: string | null;
  archived?: boolean;
  items?: ListItem[];
}

export const patchList = async (key: string, body: ListPatchBody): Promise<OptionListRow> => (await signRequest<{ list: OptionListRow }>(`/api/sign/lists/${encodeURIComponent(key)}`, { method: "PATCH", json: body })).list;

export const importList = (key: string, body: { csv: string; mode: "merge" | "replace"; dryRun?: boolean }): Promise<ImportResult> => signRequest<ImportResult>(`/api/sign/lists/${encodeURIComponent(key)}/import`, { json: body });

export const resetList = async (key: string): Promise<OptionListRow> => (await signRequest<{ list: OptionListRow }>(`/api/sign/lists/${encodeURIComponent(key)}/reset`, { json: {} })).list;

/** The address a browser opens to download a list as CSV. */
export const exportListUrl = (key: string): string => `/api/sign/lists/${encodeURIComponent(key)}/export`;
