import { parseBackOfficeBaseUrl } from "./link";

// ============================================================
// The Back Office rail of the Inbox: a narrow strip on the right, beside the Customer information
// panel, holding quick actions. Today it holds one (it opens the Back Office panel). These are the
// pure parts (is it drawn, how wide, what is remembered), so they can be tested without a DOM.
// ============================================================

/** Remembered per browser (a personal layout choice, like the pane widths). "true" means expanded. */
export const BACK_OFFICE_RAIL_STORAGE_KEY = "wacrm:inbox:back-office-rail-expanded";

/** Icon-only width, in px. */
export const BACK_OFFICE_RAIL_COLLAPSED_PX = 44;
/** Width with the label beside the icon, in px. */
export const BACK_OFFICE_RAIL_EXPANDED_PX = 216;

/** The rail (and the narrow-screen button) exist only when the Back Office address is configured and valid. */
export function backOfficeEnabled(baseUrl: string | null | undefined): baseUrl is string {
  return parseBackOfficeBaseUrl(baseUrl) !== null;
}

export function backOfficeRailWidthPx(expanded: boolean): number {
  return expanded ? BACK_OFFICE_RAIL_EXPANDED_PX : BACK_OFFICE_RAIL_COLLAPSED_PX;
}

/** The remembered choice; minimised when nothing is stored or storage is unavailable. */
export function readRailExpanded(storage: Pick<Storage, "getItem"> | null | undefined): boolean {
  try {
    return storage?.getItem(BACK_OFFICE_RAIL_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Remembers the choice. Best effort: a blocked or full storage is ignored. */
export function writeRailExpanded(storage: Pick<Storage, "setItem"> | null | undefined, expanded: boolean): void {
  try {
    storage?.setItem(BACK_OFFICE_RAIL_STORAGE_KEY, String(expanded));
  } catch {
    // Persistence is best-effort.
  }
}

/** The browser's localStorage, or null where reading the property itself throws. */
export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
