import { buildBackOfficeUrl } from "./link";

// ============================================================
// The Back Office panel (slides in from the right across the chat): a "Find an app user" form with a
// phone box and a Search button. What Search does depends on BACK_OFFICE_EMBED:
//   off (default)  the Back Office opens in a new tab and the panel says so
//   on             the Back Office loads in a frame inside the panel
// The phone number stays in the browser: nothing here (or anywhere on the way) sends it to Halo's server.
// Pure, so the rules can be tested without a DOM.
// ============================================================

export type PanelStatus = "closed" | "open" | "searching";

export interface PanelState {
  status: PanelStatus;
  /** What is in the phone box right now. */
  phone: string;
  /** The phone the last Search used (trimmed), or null before any Search. */
  searched: string | null;
  /** Counts Searches; the frame is keyed by it so a new Search always loads a fresh page, even for the same number. */
  searchId: number;
  /** The frame has finished loading (embed on). */
  frameLoaded: boolean;
}

export type PanelAction =
  | { type: "open"; contactPhone: string | null | undefined }
  | { type: "close" }
  | { type: "edit"; phone: string }
  | { type: "search" }
  | { type: "reset" }
  | { type: "frame-loaded" };

export const PANEL_CLOSED: PanelState = { status: "closed", phone: "", searched: null, searchId: 0, frameLoaded: false };

/**
 * What the phone box starts with: the contact's number exactly as Halo holds it (never normalised), or
 * empty when the contact has none (a web chat visitor, for instance).
 */
export function panelPrefill(contactPhone: string | null | undefined): string {
  return typeof contactPhone === "string" ? contactPhone : "";
}

/** In a frame inside the panel (BACK_OFFICE_EMBED on) or in a new tab (off, the default). */
export function searchMode(embed: boolean): "iframe" | "new-tab" {
  return embed ? "iframe" : "new-tab";
}

/** The page Search goes to for what is in the box; null while the box is blank (Search does nothing). */
export function panelTargetUrl(baseUrl: string | null | undefined, phone: string): string | null {
  return buildBackOfficeUrl(baseUrl, phone);
}

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "open":
      return { ...PANEL_CLOSED, status: "open", phone: panelPrefill(action.contactPhone) };
    case "close":
      return PANEL_CLOSED;
    case "edit":
      return state.status === "closed" ? state : { ...state, phone: action.phone };
    case "search": {
      if (state.status === "closed") return state;
      const trimmed = state.phone.trim();
      if (!trimmed) return state;
      return { ...state, status: "searching", searched: trimmed, searchId: state.searchId + 1, frameLoaded: false };
    }
    case "reset":
      return state.status === "closed" ? state : { ...PANEL_CLOSED, status: "open", searchId: state.searchId };
    case "frame-loaded":
      return state.status === "searching" ? { ...state, frameLoaded: true } : state;
  }
}
