"use client";

import { useEffect, useId, useRef, type CSSProperties, type Dispatch } from "react";
import { Building2, ExternalLink, Loader2, Maximize2, Minimize2, Minus, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  MINIMISED_UNLOAD_MS,
  dismissAction,
  panelTargetUrl,
  panelWidthCss,
  searchMode,
  type PanelAction,
  type PanelState,
} from "@/lib/back-office/panel";
import { cn } from "@/lib/utils";

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const GHOST_BUTTON = cn(
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
  FOCUS_RING,
);

/** The frame is sandboxed: scripts and forms run (the Back Office needs them), but it cannot reach Halo's page or navigate it. */
export const BACK_OFFICE_FRAME_SANDBOX = "allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

/**
 * What is inside the panel: the "Find an app user" form and, below it, either the embedded Back Office (BACK_OFFICE_EMBED on) or a short line saying
 * the Back Office opened in a new tab (off). Draws no dialog of its own, so it can be rendered on its own.
 */
export function BackOfficePanelBody({
  state,
  baseUrl,
  embed,
  contactHasPhone,
  onEdit,
  onSearch,
  onReset,
  onClose,
  onMinimize,
  onToggleMaximize,
  onFrameLoaded,
  phoneInputRef,
  titleId,
}: {
  state: PanelState;
  baseUrl: string;
  embed: boolean;
  /** The open contact has a phone number (when not, the form says to type one). */
  contactHasPhone: boolean;
  onEdit: (phone: string) => void;
  onSearch: () => void;
  onReset: () => void;
  onClose: () => void;
  /** Put the panel away into the rail, keeping the page that is loaded in it. */
  onMinimize: () => void;
  /** Between the usual 60% of the screen and all of it. */
  onToggleMaximize: () => void;
  onFrameLoaded: () => void;
  phoneInputRef?: React.RefObject<HTMLInputElement | null>;
  titleId?: string;
}) {
  const t = useTranslations("Inbox.backOffice");
  const inputId = useId();
  const mode = searchMode(embed);
  const searching = state.status === "searching";
  const typedUrl = panelTargetUrl(baseUrl, state.phone);
  // The frame's address carries a hint that the page is shown inside Halo; "Open in new tab" (typedUrl) never does.
  const frameSrc = searching ? panelTargetUrl(baseUrl, state.searched ?? "", { embedded: true }) : null;
  const showNoPhoneHint = !contactHasPhone && state.searched === null && state.phone.trim() === "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Building2 className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-base font-semibold text-foreground">{t("panelTitle")}</h2>
          <p className="truncate text-xs text-muted-foreground">{t("panelSubtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" onClick={onMinimize} aria-label={t("minimise")} title={t("minimise")} data-action="minimise" className={cn(GHOST_BUTTON, "w-8 px-0")}>
            <Minus className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onToggleMaximize}
            aria-label={state.maximized ? t("restoreSize") : t("maximise")}
            title={state.maximized ? t("restoreSize") : t("maximise")}
            aria-pressed={state.maximized}
            data-action="maximise"
            className={cn(GHOST_BUTTON, "hidden w-8 px-0 sm:inline-flex")}
          >
            {state.maximized ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
          </button>
          <button type="button" onClick={onClose} aria-label={t("close")} title={t("close")} data-action="close" className={cn(GHOST_BUTTON, "w-8 px-0")}>
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      <form
        className="space-y-2 border-b border-border px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSearch();
        }}
      >
        <label htmlFor={inputId} className="block text-sm font-medium text-foreground">
          {t("findTitle")}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id={inputId}
            ref={phoneInputRef}
            type="tel"
            inputMode="tel"
            autoComplete="off"
            value={state.phone}
            onChange={(e) => onEdit(e.target.value)}
            placeholder={t("phonePlaceholder")}
            aria-label={t("phoneLabel")}
            className={cn(
              "h-9 min-w-48 flex-1 rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground",
              FOCUS_RING,
            )}
          />
          <button
            type="submit"
            disabled={typedUrl === null}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50",
              FOCUS_RING,
            )}
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            {t("search")}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {typedUrl ? (
            <a href={typedUrl} target="_blank" rel="noopener noreferrer" className={cn(GHOST_BUTTON, "-ml-2.5")}>
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              {t("openInNewTab")}
            </a>
          ) : (
            <span aria-disabled="true" className={cn(GHOST_BUTTON, "-ml-2.5 cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground")}>
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              {t("openInNewTab")}
            </span>
          )}
          {searching && (
            <button type="button" onClick={onReset} className={GHOST_BUTTON}>
              {t("findAnother")}
            </button>
          )}
        </div>
        {showNoPhoneHint && <p className="text-xs text-muted-foreground">{t("noPhone")}</p>}
      </form>

      {searching && mode === "new-tab" && (
        <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
          {t("openedInTab")}
        </p>
      )}

      {searching && mode === "iframe" && frameSrc && (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            {!state.frameLoaded && (
              <div role="status" className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t("frameLoading")}
              </div>
            )}
            <iframe
              key={state.searchId}
              src={frameSrc}
              title={t("frameTitle")}
              sandbox={BACK_OFFICE_FRAME_SANDBOX}
              referrerPolicy="no-referrer"
              onLoad={onFrameLoaded}
              className="h-full w-full border-0 bg-background"
            />
          </div>
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{t("frameNote")}</p>
        </div>
      )}
    </div>
  );
}

/**
 * The Back Office panel: slides in from the right edge across the chat (full width on a phone; otherwise 60% of the screen, at least 360 px, or the
 * whole screen when maximised). A dialog: focus moves in (to the phone box) and comes back to the button that opened it, Tab stays inside.
 *
 * Three ways out, which differ in what they keep:
 *   Minimise (and Esc, or a click outside, while a search is on screen)  puts it away into the rail. The page in the frame stays loaded, hidden, and the
 *                                                                      rail button brings it back as it was. Left minimised for ten minutes, it is closed.
 *   Close (and Esc on a form with nothing to keep)                      unmounts everything, so a frame never keeps loading in the background.
 * The phone number lives in this browser only.
 */
export function BackOfficePanel({
  state,
  dispatch,
  baseUrl,
  embed,
  contactPhone,
}: {
  state: PanelState;
  dispatch: Dispatch<PanelAction>;
  baseUrl: string;
  embed: boolean;
  contactPhone: string | null | undefined;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();

  // A record must not sit in a hidden frame all shift: a panel left minimised for ten minutes is closed (and the frame with it).
  useEffect(() => {
    if (!state.minimized) return;
    const timer = window.setTimeout(() => dispatch({ type: "close" }), MINIMISED_UNLOAD_MS);
    return () => window.clearTimeout(timer);
  }, [state.minimized, dispatch]);

  const onSearch = () => {
    const url = panelTargetUrl(baseUrl, state.phone);
    if (!url) return;
    dispatch({ type: "search" });
    // A real click opened this, so the browser allows the tab. If a blocker stops it anyway, "Open in new tab" is still on screen.
    if (searchMode(embed) === "new-tab") window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <Sheet open={state.status !== "closed" && !state.minimized} onOpenChange={(open) => !open && dispatch({ type: dismissAction(state) })}>
      <SheetContent
        side="right"
        showCloseButton={false}
        // Put away, the page in the frame is kept (hidden); closed, nothing is.
        keepMounted={state.status !== "closed"}
        aria-labelledby={titleId}
        initialFocus={inputRef}
        overlayClassName="bg-foreground/20"
        data-maximized={state.maximized ? "true" : "false"}
        style={{ "--bo-panel-w": panelWidthCss(state.maximized) } as CSSProperties}
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:w-(--bo-panel-w) data-[side=right]:sm:max-w-none"
      >
        <BackOfficePanelBody
          state={state}
          baseUrl={baseUrl}
          embed={embed}
          contactHasPhone={typeof contactPhone === "string" && contactPhone.trim() !== ""}
          onEdit={(phone) => dispatch({ type: "edit", phone })}
          onSearch={onSearch}
          onReset={() => {
            dispatch({ type: "reset" });
            inputRef.current?.focus();
          }}
          onClose={() => dispatch({ type: "close" })}
          onMinimize={() => dispatch({ type: "minimize" })}
          onToggleMaximize={() => dispatch({ type: "toggle-maximize" })}
          onFrameLoaded={() => dispatch({ type: "frame-loaded" })}
          phoneInputRef={inputRef}
          titleId={titleId}
        />
      </SheetContent>
    </Sheet>
  );
}
