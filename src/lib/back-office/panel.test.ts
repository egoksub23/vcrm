import { describe, expect, it } from "vitest";

import {
  MINIMISED_UNLOAD_MS,
  PANEL_CLOSED,
  PANEL_DEFAULT_VW,
  PANEL_MIN_PX,
  dismissAction,
  panelPrefill,
  panelReducer,
  panelTargetUrl,
  panelWidthCss,
  searchMode,
  type PanelAction,
  type PanelState,
} from "./panel";
import {
  BACK_OFFICE_RAIL_COLLAPSED_PX,
  BACK_OFFICE_RAIL_EXPANDED_PX,
  BACK_OFFICE_RAIL_STORAGE_KEY,
  backOfficeEnabled,
  backOfficeRailWidthPx,
  readRailExpanded,
  writeRailExpanded,
} from "./rail";

const UAT = "https://v2-uat.vircle.net/app-user-details-b";

describe("the address a frame is given", () => {
  it("adds &embed=1 after the phone for the frame only, and never for Open in new tab", () => {
    expect(panelTargetUrl(UAT, "+60123456789")).toBe(`${UAT}#q=%2B60123456789`);
    expect(panelTargetUrl(UAT, "+60123456789", { embedded: true })).toBe(`${UAT}#q=%2B60123456789&embed=1`);
    expect(panelTargetUrl(UAT, "  ", { embedded: true })).toBeNull();
    expect(panelTargetUrl(null, "0123", { embedded: true })).toBeNull();
  });
});

const run = (actions: PanelAction[], from: PanelState = PANEL_CLOSED) => actions.reduce(panelReducer, from);

describe("panelPrefill", () => {
  it("is the contact's phone exactly as held", () => {
    expect(panelPrefill("+60123456789")).toBe("+60123456789");
    expect(panelPrefill("0123456789")).toBe("0123456789");
    expect(panelPrefill(" 012 345 ")).toBe(" 012 345 ");
  });

  it("is empty for a contact with no phone", () => {
    expect(panelPrefill(null)).toBe("");
    expect(panelPrefill(undefined)).toBe("");
    expect(panelPrefill("")).toBe("");
  });
});

describe("searchMode", () => {
  it("opens a frame only when embedding is on; a new tab otherwise (the default)", () => {
    expect(searchMode(true)).toBe("iframe");
    expect(searchMode(false)).toBe("new-tab");
  });
});

describe("panelTargetUrl", () => {
  it("builds the #q= link from what is typed", () => {
    expect(panelTargetUrl(UAT, "+60123456789")).toBe(`${UAT}#q=%2B60123456789`);
    expect(panelTargetUrl(UAT, "  ")).toBeNull();
    expect(panelTargetUrl("http://x.example", "0123")).toBeNull();
  });
});

describe("panelReducer", () => {
  it("starts closed", () => {
    expect(PANEL_CLOSED.status).toBe("closed");
  });

  it("opens with the contact's phone in the box and nothing searched", () => {
    const s = run([{ type: "open", contactPhone: "+60123456789" }]);
    expect(s).toMatchObject({ status: "open", phone: "+60123456789", searched: null, frameLoaded: false });
  });

  it("opens with an empty box when the contact has no phone", () => {
    expect(run([{ type: "open", contactPhone: null }]).phone).toBe("");
  });

  it("lets the person edit the prefilled number without searching", () => {
    const s = run([{ type: "open", contactPhone: "0123" }, { type: "edit", phone: "0199" }]);
    expect(s).toMatchObject({ status: "open", phone: "0199", searched: null });
  });

  it("searches with the trimmed box content and counts the search", () => {
    const s = run([{ type: "open", contactPhone: "0123" }, { type: "edit", phone: "  0199 " }, { type: "search" }]);
    expect(s).toMatchObject({ status: "searching", searched: "0199", searchId: 1, frameLoaded: false });
  });

  it("does nothing on Search while the box is blank", () => {
    const opened = run([{ type: "open", contactPhone: "" }]);
    expect(run([{ type: "search" }], opened)).toBe(opened);
    expect(run([{ type: "edit", phone: "   " }, { type: "search" }], opened).status).toBe("open");
  });

  it("a second search (even for the same number) gets a new search id, so the frame is loaded afresh", () => {
    const s = run([{ type: "open", contactPhone: "0123" }, { type: "search" }, { type: "frame-loaded" }, { type: "search" }]);
    expect(s).toMatchObject({ status: "searching", searchId: 2, frameLoaded: false });
  });

  it("re-entering a different phone while searching searches that one", () => {
    const s = run([{ type: "open", contactPhone: "0123" }, { type: "search" }, { type: "edit", phone: "0199" }, { type: "search" }]);
    expect(s).toMatchObject({ searched: "0199", searchId: 2 });
  });

  it("keeps the searched number until the next Search, however the box is edited", () => {
    const s = run([{ type: "open", contactPhone: "0123" }, { type: "search" }, { type: "edit", phone: "09" }]);
    expect(s).toMatchObject({ status: "searching", searched: "0123", phone: "09" });
  });

  it("marks the frame loaded only while searching", () => {
    expect(run([{ type: "frame-loaded" }]).frameLoaded).toBe(false);
    const open = run([{ type: "open", contactPhone: "0123" }, { type: "frame-loaded" }]);
    expect(open.frameLoaded).toBe(false);
    expect(run([{ type: "open", contactPhone: "0123" }, { type: "search" }, { type: "frame-loaded" }]).frameLoaded).toBe(true);
  });

  it("Find another user clears the box and the search and goes back to the form", () => {
    const s = run([{ type: "open", contactPhone: "0123" }, { type: "search" }, { type: "reset" }]);
    expect(s).toMatchObject({ status: "open", phone: "", searched: null, frameLoaded: false });
    // a later search still gets a fresh id
    expect(run([{ type: "edit", phone: "0199" }, { type: "search" }], s).searchId).toBe(2);
  });

  it("closing drops everything, so a frame is unmounted and nothing is remembered", () => {
    const s = run([{ type: "open", contactPhone: "0123" }, { type: "search" }, { type: "close" }]);
    expect(s).toEqual(PANEL_CLOSED);
  });

  it("reopening starts again from the open contact's phone", () => {
    const s = run([{ type: "open", contactPhone: "0123" }, { type: "search" }, { type: "close" }, { type: "open", contactPhone: "0777" }]);
    expect(s).toMatchObject({ status: "open", phone: "0777", searched: null });
  });

  it("ignores edit, search, reset and frame-loaded while closed", () => {
    for (const a of [{ type: "edit", phone: "1" }, { type: "search" }, { type: "reset" }, { type: "frame-loaded" }] as PanelAction[]) {
      expect(panelReducer(PANEL_CLOSED, a)).toBe(PANEL_CLOSED);
    }
  });
});

describe("the size of the panel", () => {
  it("opens at 60% of the screen, never narrower than 360 px, and fills the screen when maximised", () => {
    expect(PANEL_DEFAULT_VW).toBe(60);
    expect(PANEL_MIN_PX).toBe(360);
    expect(panelWidthCss(false)).toBe("max(360px, 60vw)");
    expect(panelWidthCss(true)).toBe("100vw");
  });

  it("starts at the usual size, and maximise toggles it", () => {
    const s = run([{ type: "open", contactPhone: "0123" }]);
    expect(s.maximized).toBe(false);
    const big = panelReducer(s, { type: "toggle-maximize" });
    expect(big.maximized).toBe(true);
    expect(panelReducer(big, { type: "toggle-maximize" }).maximized).toBe(false);
  });

  it("keeps the size through Find another user, but a fresh open is the usual size again", () => {
    const big = run([{ type: "open", contactPhone: "0123" }, { type: "toggle-maximize" }, { type: "search" }, { type: "reset" }]);
    expect(big).toMatchObject({ status: "open", maximized: true, searched: null });
    expect(run([{ type: "close" }, { type: "open", contactPhone: "0123" }], big).maximized).toBe(false);
  });

  it("cannot be resized while it is away or closed", () => {
    expect(panelReducer(PANEL_CLOSED, { type: "toggle-maximize" })).toBe(PANEL_CLOSED);
    const away = run([{ type: "open", contactPhone: "0123" }, { type: "minimize" }]);
    expect(panelReducer(away, { type: "toggle-maximize" })).toBe(away);
  });
});

describe("minimising into the rail", () => {
  const searching = () => run([{ type: "open", contactPhone: "0123" }, { type: "search" }, { type: "frame-loaded" }]);

  it("puts the panel away and KEEPS the search, the typed number and the loaded frame", () => {
    const s = panelReducer(searching(), { type: "minimize" });
    expect(s).toMatchObject({ status: "searching", minimized: true, searched: "0123", searchId: 1, frameLoaded: true });
  });

  it("brings the same panel back from the rail without starting again", () => {
    const edited = run([{ type: "edit", phone: "0199" }], searching());
    const back = run([{ type: "minimize" }, { type: "open", contactPhone: "0777" }], edited);
    // the contact's phone (0777) does not overwrite what the agent had; nothing was reloaded
    expect(back).toMatchObject({ status: "searching", minimized: false, phone: "0199", searched: "0123", searchId: 1, frameLoaded: true });
  });

  it("restore does the same, and does nothing to a panel that is not away", () => {
    const away = panelReducer(searching(), { type: "minimize" });
    expect(panelReducer(away, { type: "restore" }).minimized).toBe(false);
    const up = searching();
    expect(panelReducer(up, { type: "restore" })).toBe(up);
  });

  it("is nothing to minimise while closed, and minimising twice changes nothing", () => {
    expect(panelReducer(PANEL_CLOSED, { type: "minimize" })).toBe(PANEL_CLOSED);
    const away = panelReducer(searching(), { type: "minimize" });
    expect(panelReducer(away, { type: "minimize" })).toBe(away);
  });

  it("closing from the rail drops everything, so the frame is unmounted", () => {
    expect(run([{ type: "minimize" }, { type: "close" }], searching())).toEqual(PANEL_CLOSED);
  });

  it("opening a closed panel is a fresh start, never a stale minimised one", () => {
    expect(run([{ type: "close" }, { type: "open", contactPhone: "0777" }], panelReducer(searching(), { type: "minimize" }))).toMatchObject({ status: "open", minimized: false, phone: "0777", searched: null });
  });

  it("Esc and a click outside put a search away, but close a form that has nothing to keep", () => {
    expect(dismissAction(searching())).toBe("minimize");
    expect(dismissAction(run([{ type: "open", contactPhone: "0123" }]))).toBe("close");
  });

  it("a panel left away is closed after ten minutes (the panel's timer uses this)", () => {
    expect(MINIMISED_UNLOAD_MS).toBe(10 * 60_000);
  });
});

describe("the rail", () => {
  it("is drawn only for a valid https address", () => {
    expect(backOfficeEnabled(UAT)).toBe(true);
    expect(backOfficeEnabled(null)).toBe(false);
    expect(backOfficeEnabled(undefined)).toBe(false);
    expect(backOfficeEnabled("")).toBe(false);
    expect(backOfficeEnabled("http://v2-uat.vircle.net/x")).toBe(false);
  });

  it("is narrow when minimised and wider when expanded", () => {
    expect(backOfficeRailWidthPx(false)).toBe(BACK_OFFICE_RAIL_COLLAPSED_PX);
    expect(backOfficeRailWidthPx(true)).toBe(BACK_OFFICE_RAIL_EXPANDED_PX);
    expect(BACK_OFFICE_RAIL_COLLAPSED_PX).toBeLessThan(BACK_OFFICE_RAIL_EXPANDED_PX);
  });

  it("remembers the choice, and is minimised without a stored value", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readRailExpanded(storage)).toBe(false);
    writeRailExpanded(storage, true);
    expect(store.get(BACK_OFFICE_RAIL_STORAGE_KEY)).toBe("true");
    expect(readRailExpanded(storage)).toBe(true);
    writeRailExpanded(storage, false);
    expect(readRailExpanded(storage)).toBe(false);
  });

  it("renders correctly without storage (null, or one that throws)", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readRailExpanded(null)).toBe(false);
    expect(readRailExpanded(undefined)).toBe(false);
    expect(readRailExpanded(broken)).toBe(false);
    expect(() => writeRailExpanded(broken, true)).not.toThrow();
    expect(() => writeRailExpanded(null, true)).not.toThrow();
  });
});
