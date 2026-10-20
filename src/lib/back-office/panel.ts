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

/** How wide the panel opens, as a share of the screen (never narrower than PANEL_MIN_PX; the whole width on a phone). */
export const PANEL_DEFAULT_VW = 60;
export const PANEL_MIN_PX = 360;
/** A panel left minimised this long is closed, so a parent's record does not sit in a hidden frame for the rest of the shift. */
export const MINIMISED_UNLOAD_MS = 10 * 60_000;

/** The CSS width of the panel at sm and wider: 60% of the screen (at least 360 px), or all of it when maximised. */
export function panelWidthCss(maximized: boolean): string {
  return maximized ? "100vw" : `max(${PANEL_MIN_PX}px, ${PANEL_DEFAULT_VW}vw)`;
}

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
  /** Put away into the rail, but not closed: the page in the frame stays loaded, and the rail button brings it back as it was. */
  minimized: boolean;
  /** Wider than the usual 60%: the whole screen. */
  maximized: boolean;
}

export type PanelAction =
  | { type: "open"; contactPhone: string | null | undefined }
  | { type: "close" }
  | { type: "edit"; phone: string }
  | { type: "search" }
  | { type: "reset" }
  | { type: "frame-loaded" }
  | { type: "minimize" }
  | { type: "restore" }
  | { type: "toggle-maximize" };

export const PANEL_CLOSED: PanelState = { status: "closed", phone: "", searched: null, searchId: 0, frameLoaded: false, minimized: false, maximized: false };

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

/** The page Search goes to for what is in the box; null while the box is blank (Search does nothing). `embedded` is the address for the frame. */
export function panelTargetUrl(baseUrl: string | null | undefined, phone: string, opts: { embedded?: boolean } = {}): string | null {
  return buildBackOfficeUrl(baseUrl, phone, opts);
}

/**
 * What Esc and a click outside the panel do: put a search that is on screen away (the page and what was typed are kept), but close a form with nothing
 * to keep. The close button always closes.
 */
export function dismissAction(state: PanelState): "minimize" | "close" {
  return state.status === "searching" ? "minimize" : "close";
}

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "open":
      // The rail button on a panel that was put away brings back the same panel, search and all, rather than starting again.
      if (state.status !== "closed" && state.minimized) return { ...state, minimized: false };
      return { ...PANEL_CLOSED, status: "open", phone: panelPrefill(action.contactPhone) };
    case "minimize":
      return state.status === "closed" || state.minimized ? state : { ...state, minimized: true };
    case "restore":
      return state.status === "closed" || !state.minimized ? state : { ...state, minimized: false };
    case "toggle-maximize":
      return state.status === "closed" || state.minimized ? state : { ...state, maximized: !state.maximized };
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
      return state.status === "closed" ? state : { ...PANEL_CLOSED, status: "open", searchId: state.searchId, maximized: state.maximized };
    case "frame-loaded":
      return state.status === "searching" ? { ...state, frameLoaded: true } : state;
  }
}
