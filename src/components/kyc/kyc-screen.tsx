"use client";

// ============================================================
// KYC review: the latest ID checks of everybody (or one friend id), the ID image, the masked details (revealed for two minutes with kyc.reveal) and,
// with kyc.decide, Approve or Reject. Administrators and owners also get the Access log tab.
//
// The screen fills the window and is split into three panes that scroll on their own (the Inbox's shape, and its resize handle): the queue, the ID
// image, and who it is plus the decision. The page itself never scrolls, so Approve and Reject are always in sight.
//
// ONE detail is on screen at a time. The image viewer and the decision box are mounted once and reset themselves when the check changes, rather than
// being replaced through a changing `key`: a replacement that is not committed used to leave the previous child's ID panel behind, so two children
// could be on screen at once (0.96.0 and before).
//
// What the browser holds: the MASKED list the server sent, and, for at most two minutes, the one validation the reviewer revealed. Nothing is stored
// except the friend ids of recent searches and the pane widths (per person, in this browser, no data). The revealed copy is dropped when the reviewer
// opens another validation, searches again, leaves the tab, hides the page or two minutes pass.
// ============================================================

import { ArrowLeft, ChevronLeft, ChevronRight, Search, ShieldCheck, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";

import { NoAccess } from "@/components/auth/no-access";
import { PaneResizeHandle } from "@/components/inbox/pane-resize-handle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth, useCapability } from "@/hooks/use-auth";
import { useNow } from "@/hooks/use-now";
import { usePaneWidth } from "@/hooks/use-pane-width";
import { cn } from "@/lib/utils";
import { FRIEND_ID_RE, normaliseFriendId, type KycDecision, type KycDecisionResult, type KycStatus, type KycValidation } from "@/lib/kyc/types";

import { AccessLogPanel } from "./access-log";
import { getStatus, getValidations, postDecision } from "./api";
import { DecisionPanel } from "./decision";
import {
  DEFAULT_FILTERS,
  REVEAL_MS,
  addRecent,
  loadRecent,
  matchesFilters,
  resultOptions,
  revealExpired,
  saveRecent,
  shouldKeepPaging,
  type KycFilters,
} from "./helpers";
import { FilterBar } from "./filter-bar";
import { ImageViewer } from "./image-viewer";
import { DataCard, ErrorPanel, ProvisionalNote, ReadOnlyNotice, SetupNotice, StatusChip, TypeChip, UatBanner, ValidationList, rowKey } from "./parts";

type Tab = "review" | "log";
type Phase = "idle" | "loading" | "ready" | "error";

interface Revealed {
  key: string;
  item: KycValidation;
  until: number;
}

/** What one scan of the back end came back with: the checks gathered, where the next page starts, and the error that stopped it (if any). */
interface ScanResult {
  items: KycValidation[];
  before: string | null;
  error: string | null;
}

const LIST_PANE = { key: "halo:kyc:pane:list", px: 340, min: 260 };
const SIDE_PANE = { key: "halo:kyc:pane:side", px: 400, min: 300 };
const paneMax = () => (typeof window === "undefined" ? 640 : Math.max(320, Math.round(window.innerWidth * 0.45)));

const browserStorage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function KycScreen() {
  const t = useTranslations("Kyc");
  const locale = useLocale();
  const { user, profile } = useAuth();
  const canMenu = useCapability("menu.kyc");
  const now = useNow(30_000);

  const userId = user?.id ?? "";
  const viewerName = profile?.full_name?.trim() || profile?.email || user?.email || "";

  const [status, setStatus] = useState<(KycStatus & { service?: "up" | "down" }) | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [tab, setTab] = useState<Tab>("review");

  const [draft, setDraft] = useState("");
  const [draftInvalid, setDraftInvalid] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  // "" = the latest checks of everybody (the start page); otherwise the list is filtered to this friend id
  const [friendId, setFriendId] = useState<string>("");
  const [filters, setFilters] = useState<KycFilters>(DEFAULT_FILTERS);
  const [phase, setPhase] = useState<Phase>("idle");
  const [nextBeforeId, setNextBeforeId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const started = useRef(false);
  const [errorCode, setErrorCode] = useState<string>("");
  /** An error that stopped a scan after some checks were already found: the list is shown, with a note. */
  const [scanError, setScanError] = useState<string | null>(null);
  const [items, setItems] = useState<KycValidation[]>([]);
  const [fallback, setFallback] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  /** Checks decided in this session: they stay in the list under "Needs review" so the reviewer sees what was just recorded. */
  const [keep, setKeep] = useState<readonly string[]>([]);

  const listPane = usePaneWidth(LIST_PANE.key, LIST_PANE.px);
  const sidePane = usePaneWidth(SIDE_PANE.key, SIDE_PANE.px);

  const seq = useRef(0);
  const detailRef = useRef<HTMLHeadingElement | null>(null);
  const listRef = useRef<HTMLHeadingElement | null>(null);
  const focusDetail = useRef(false);
  // the validation open right now, read after an await: a reveal that comes back for another one is thrown away, not kept
  const openKey = useRef<string | null>(null);

  // ---- status and recent searches ----
  const loadStatus = useCallback(async () => {
    const res = await getStatus(false);
    if (res.ok) {
      setStatus(res.data);
      setStatusError(null);
    } else setStatusError(res.code);
  }, []);
  useEffect(() => {
    // load-on-mount fetch whose result sets state
     
    void loadStatus();
  }, [loadStatus]);
  useEffect(() => {
    // localStorage is not readable during the server render, so the recent searches are read once the person is known
     
    setRecent(loadRecent(browserStorage(), userId, (v) => FRIEND_ID_RE.test(v)));
  }, [userId]);

  const checkConnection = async () => {
    setChecking(true);
    const res = await getStatus(true);
    setChecking(false);
    if (res.ok) setStatus(res.data);
    else setStatusError(res.code);
  };

  // ---- reading the back end ----
  /**
   * Read pages until there are enough checks that match, or the back end runs out, or the cap is reached. Only the document kind is a filter the back
   * end applies; "Approved only" is why this has to keep reading. Each page is one call and one access-log row, so the cap matters (shouldKeepPaging).
   */
  const scan = useCallback(async (id: string, f: KycFilters, startBefore: string | null, seed: readonly KycValidation[], mine: number): Promise<ScanResult | null> => {
    let all: KycValidation[] = [...seed];
    let before = startBefore;
    let pages = 0;
    for (;;) {
      const res = await getValidations(id, {
        reload: seed.length > 0 || pages > 0,
        beforeId: before ?? undefined,
        docType: f.docType || undefined,
      });
      if (mine !== seq.current) return null;
      if (!res.ok) return { items: all, before, error: res.code };
      pages += 1;
      const have = new Set(all.map((v) => v.id).filter(Boolean));
      all = [...all, ...res.data.items.filter((v) => !v.id || !have.has(v.id))];
      before = res.data.nextBeforeId;
      setFallback(res.data.fallback);
      const matches = all.filter((v) => matchesFilters(v, f)).length;
      if (!shouldKeepPaging({ matches, pages, hasMore: before !== null, filters: f })) return { items: all, before, error: null };
    }
  }, []);

  const run = useCallback(
    async (id: string, f: KycFilters) => {
      const mine = ++seq.current;
      setFriendId(id);
      setFilters(f);
      setPhase("loading");
      setErrorCode("");
      setScanError(null);
      setKeep([]);
      openKey.current = null;
      setSelectedKey(null);
      setRevealed(null);
      setRevealError(null);
      setMobilePane("list");
      const out = await scan(id, f, null, [], mine);
      if (!out) return;
      if (out.error && out.items.length === 0) {
        setPhase("error");
        setErrorCode(out.error);
        setItems([]);
        setNextBeforeId(null);
        return;
      }
      setItems(out.items);
      setNextBeforeId(out.before);
      setScanError(out.error);
      setPhase("ready");
    },
    [scan],
  );

  // The page opens on the checks that need a review (the default filter), so nobody has to know a friend id to start.
  useEffect(() => {
    if (started.current || !status?.configured || !canMenu) return;
    started.current = true;
    // load-on-mount fetch whose result sets state
     
    void run("", DEFAULT_FILTERS);
  }, [status?.configured, canMenu, run]);

  const loadMore = async (f: KycFilters = filters) => {
    if (!nextBeforeId || loadingMore || phase !== "ready") return;
    const mine = seq.current;
    setLoadingMore(true);
    setScanError(null);
    const out = await scan(friendId, f, nextBeforeId, items, mine);
    setLoadingMore(false);
    if (!out) return;
    setItems(out.items);
    setNextBeforeId(out.before);
    setScanError(out.error);
  };

  const applyFilters = (next: KycFilters) => {
    // A document kind is the back end's own filter, so it needs a fresh list; the rest only change what is shown (and may send the screen looking for more).
    if (next.docType !== filters.docType) {
      void run(friendId, next);
      return;
    }
    setFilters(next);
    setKeep([]);
    // Another review or result choice may need checks that were not read yet. Go and look, but only when what is loaded does not already fill the
    // list: nothing more is pulled than the choice needs, and "All checks" never reads beyond the page that is there.
    const have = items.filter((v) => matchesFilters(v, next)).length;
    if (shouldKeepPaging({ matches: have, pages: 0, hasMore: nextBeforeId !== null, filters: next })) void loadMore(next);
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const id = normaliseFriendId(draft);
    if (id === "") {
      setDraftInvalid(false);
      void run("", filters);
      return;
    }
    if (!FRIEND_ID_RE.test(id)) {
      setDraftInvalid(true);
      return;
    }
    setDraftInvalid(false);
    setDraft(id);
    const next = addRecent(recent, id);
    setRecent(next);
    saveRecent(browserStorage(), userId, next);
    void run(id, filters);
  };

  const clear = () => {
    setDraft("");
    setDraftInvalid(false);
    void run("", filters);
  };

  const searchRecent = (id: string) => {
    setDraft(id);
    setDraftInvalid(false);
    const next = addRecent(recent, id);
    setRecent(next);
    saveRecent(browserStorage(), userId, next);
    void run(id, filters);
  };

  const clearRecent = () => {
    setRecent([]);
    saveRecent(browserStorage(), userId, []);
  };

  // ---- what the list shows ----
  // A check decided a moment ago stays in place even when the filter would now drop it, so the reviewer can see what was recorded.
  const visible = useMemo(() => items.filter((v) => matchesFilters(v, filters) || (v.id !== "" && keep.includes(v.id))), [items, filters, keep]);
  const results = useMemo(() => resultOptions(items), [items]);
  const filtered = filters.review !== "all" || filters.result !== "";

  // ---- selection and focus ----
  const index = useMemo(() => visible.findIndex((v, i) => rowKey(v, i) === selectedKey), [visible, selectedKey]);
  const selected = index >= 0 ? visible[index] : null;

  const open = (v: KycValidation, i: number) => {
    setRevealed(null);
    setRevealError(null);
    focusDetail.current = true;
    openKey.current = rowKey(v, i);
    setSelectedKey(rowKey(v, i));
    setMobilePane("detail");
  };

  const step = (by: 1 | -1) => {
    const next = visible[index + by];
    if (next) open(next, index + by);
  };

  // Move focus to the detail's heading when a validation is opened (not on first paint), and back to the list when the phone's back arrow is used.
  useEffect(() => {
    if (selectedKey && focusDetail.current) {
      focusDetail.current = false;
      detailRef.current?.focus();
    }
  }, [selectedKey]);

  const back = () => {
    setMobilePane("list");
    setRevealed(null);
    window.setTimeout(() => listRef.current?.focus(), 0);
  };

  // ---- reveal: two minutes, then hidden again; also hidden when the tab is left or the page goes to the background ----
  const reveal = async () => {
    const owner = selected?.friendId || friendId;
    if (!selected || !owner || !selected.idUsable) return;
    setRevealing(true);
    setRevealError(null);
    const key = selectedKey ?? "";
    const res = await getValidations(owner, { revealValidationId: selected.id });
    setRevealing(false);
    if (openKey.current !== key) return;
    if (!res.ok) {
      setRevealError(res.code);
      return;
    }
    const item = res.data.items.find((v) => v.id === selected.id);
    if (!item) {
      setRevealError("not_found");
      return;
    }
    setRevealed({ key, item, until: Date.now() + REVEAL_MS });
  };

  useEffect(() => {
    if (!revealed) return;
    const left = revealed.until - Date.now();
    const timer = window.setTimeout(() => setRevealed(null), Math.max(0, left));
    const onVisibility = () => {
      if (document.hidden) setRevealed(null);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [revealed]);

  // ---- decisions ----
  // A decision taken: the check in the list now carries the review (the answer has what the back end recorded); nothing revealed stays open.
  const decided = (validationId: string, r: KycDecisionResult) => {
    setItems((cur) => cur.map((v) => (v.id === validationId ? { ...v, review: { raw: r.reviewStatus, tone: r.reviewTone, note: r.note, at: r.reviewedAt } } : v)));
    setKeep((cur) => (validationId && !cur.includes(validationId) ? [...cur, validationId] : cur));
    setRevealed(null);
  };

  // A decision whose outcome is unclear: read the child's list again and swap in the check as the back end holds it now.
  const refreshOne = async (validationId: string, owner: string) => {
    if (!validationId || !owner) return;
    const res = await getValidations(owner, { reload: true });
    if (!res.ok) return;
    const fresh = res.data.items.find((v) => v.id === validationId);
    if (fresh) {
      setItems((cur) => cur.map((v) => (v.id === validationId ? fresh : v)));
      setKeep((cur) => (cur.includes(validationId) ? cur : [...cur, validationId]));
    }
  };

  // ---- render ----
  if (!canMenu) return <NoAccess />;

  const isAdmin = status?.isAdmin ?? false;
  const canView = status?.canView ?? false;
  const canReveal = status?.canReveal ?? false;
  const canDecide = status?.canDecide ?? false;
  const configured = status?.configured ?? false;

  const shown: KycValidation | null = selected && revealed && revealed.key === selectedKey && !revealExpired(revealed.until, now) ? revealed.item : selected;
  const isRevealed = shown !== null && shown === revealed?.item;
  const decideFriendId = shown ? shown.friendId || friendId : "";

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6">
      <header className="shrink-0 border-b border-border px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck className="size-5 text-muted-foreground" aria-hidden />
          <h1 className="text-base font-semibold text-foreground">{t("title")}</h1>
          {status?.uat ? <span className="rounded-full bg-[color:light-dark(#fef3c7,#78350f66)] px-2 py-0.5 text-xs font-medium text-[light-dark(#92400e,#fcd34d)]">UAT</span> : null}
          {status && !canDecide ? <span className="text-xs text-muted-foreground">{t("readOnlyShort")}</span> : null}
          {isAdmin ? (
            <div role="tablist" aria-label={t("tabs.label")} className="ms-auto flex gap-1">
              {(["review", "log"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`kyc-tab-${key}`}
                  aria-selected={tab === key}
                  aria-controls={`kyc-panel-${key}`}
                  onClick={() => {
                    setTab(key);
                    setRevealed(null);
                  }}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    tab === key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`tabs.${key}`)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {status?.uat ? <div className="mt-2"><UatBanner /></div> : null}
      </header>

      {statusError && !status ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <ErrorPanel code={statusError} isAdmin={false} onRetry={() => void loadStatus()} />
        </div>
      ) : null}

      {status && !configured ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <SetupNotice status={status} />
        </div>
      ) : null}

      {tab === "log" && isAdmin ? (
        <div role="tabpanel" id="kyc-panel-log" aria-labelledby="kyc-tab-log" className="min-h-0 flex-1 overflow-y-auto p-4">
          <AccessLogPanel />
        </div>
      ) : null}

      {tab === "review" && status && configured ? (
        <div
          role={isAdmin ? "tabpanel" : undefined}
          id="kyc-panel-review"
          aria-labelledby={isAdmin ? "kyc-tab-review" : undefined}
          className="flex min-h-0 flex-1 overflow-hidden"
        >
          {/* ---- the queue ---- */}
          <section
            aria-labelledby="kyc-results-title"
            className={cn(
              "flex min-h-0 min-w-0 flex-col lg:flex-none lg:w-(--pane-w)",
              mobilePane === "detail" ? "max-lg:hidden" : "max-lg:flex-1",
            )}
            style={{ "--pane-w": `${listPane.width}px` } as CSSProperties}
          >
            <div className="shrink-0 space-y-2 border-b border-border p-3">
              <form onSubmit={submit} role="search" aria-label={t("search.label")}>
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Input
                      id="kyc-friend-id"
                      value={draft}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        if (draftInvalid) setDraftInvalid(false);
                      }}
                      placeholder={t("search.placeholder")}
                      aria-label={t("search.label")}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      maxLength={200}
                      aria-invalid={draftInvalid || undefined}
                      aria-describedby={draftInvalid ? "kyc-friend-id-error" : undefined}
                      className="h-8 pr-8"
                    />
                    {draft ? (
                      <button
                        type="button"
                        onClick={clear}
                        aria-label={t("search.clear")}
                        title={t("search.clear")}
                        className="absolute inset-y-0 right-1 my-auto flex size-6 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X className="size-4" aria-hidden />
                      </button>
                    ) : null}
                  </div>
                  <Button type="submit" size="sm" disabled={phase === "loading"}>
                    <Search aria-hidden />
                    <span className="sr-only">{t("search.button")}</span>
                  </Button>
                </div>
                {draftInvalid ? (
                  <p id="kyc-friend-id-error" role="alert" className="mt-1 text-xs text-destructive">
                    {t("search.invalid")}
                  </p>
                ) : null}
                {recent.length > 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">{t("search.recent")}</span>
                    {recent.map((id) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => searchRecent(id)}
                        className="rounded-full border border-border px-2 py-0.5 font-mono text-xs text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {id}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={clearRecent}
                      className="text-xs text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {t("search.clearRecent")}
                    </button>
                  </div>
                ) : null}
              </form>

              <FilterBar filters={filters} results={results} onChange={applyFilters} disabled={phase === "loading"} />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3" aria-live="polite">
              <h2 id="kyc-results-title" ref={listRef} tabIndex={-1} className="mb-2 text-xs font-medium text-muted-foreground outline-none">
                {friendId ? t("list.forFriend", { id: friendId }) : t("list.latest")}
              </h2>
              {isAdmin && fallback ? <ProvisionalNote /> : null}
              {phase === "idle" ? <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{t("list.start")}</p> : null}
              {phase === "loading" ? (
                <div role="status" className="space-y-2" aria-busy="true">
                  <span className="sr-only">{t("list.loading")}</span>
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-14 animate-pulse rounded-xl bg-muted" />
                  ))}
                </div>
              ) : null}
              {phase === "error" ? <ErrorPanel code={errorCode} isAdmin={isAdmin} onRetry={() => void run(friendId, filters)} /> : null}
              {phase === "ready" ? (
                <>
                  <p className="mb-1 text-xs text-muted-foreground">
                    {filtered ? t("list.filteredCount", { shown: visible.length, scanned: items.length }) : t("list.count", { count: visible.length })}
                  </p>
                  {visible.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-border p-4 text-sm text-foreground">{filtered ? t("list.noMatches") : t("list.empty")}</p>
                  ) : (
                    <ValidationList items={visible} selectedKey={selectedKey} onSelect={open} now={now} />
                  )}
                  {scanError ? <div className="mt-2"><ErrorPanel code={scanError} isAdmin={isAdmin} compact /></div> : null}
                  {nextBeforeId ? (
                    <Button type="button" variant="outline" size="sm" className="mt-2 w-full" onClick={() => void loadMore()} disabled={loadingMore}>
                      {loadingMore ? t("list.loadingMore") : filtered ? t("list.keepLooking") : t("list.loadMore")}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
          </section>

          <PaneResizeHandle
            width={listPane.width}
            min={LIST_PANE.min}
            getMax={paneMax}
            dir={1}
            onChange={listPane.setWidth}
            onCommit={listPane.commit}
            onReset={listPane.reset}
            label={t("resizePanel")}
          />

          {/* ---- the check: its image, then who it is and the decision ---- */}
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1 border-s border-border max-lg:flex-col max-lg:overflow-y-auto max-lg:border-s-0",
              mobilePane === "list" && "max-lg:hidden",
            )}
          >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col max-lg:h-[60vh] max-lg:flex-none">
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                <Button variant="ghost" size="icon-sm" onClick={back} aria-label={t("detail.back")} title={t("detail.back")} className="lg:hidden">
                  <ArrowLeft aria-hidden />
                </Button>
                <h2 id="kyc-detail-title" ref={detailRef} tabIndex={-1} className="text-sm font-medium text-foreground outline-none">
                  {t("detail.heading")}
                </h2>
                {shown ? (
                  <div className="ms-auto flex items-center gap-1">
                    <span className="text-xs tabular-nums text-muted-foreground">{t("detail.position", { index: index + 1, total: visible.length })}</span>
                    <Button variant="outline" size="icon-sm" onClick={() => step(-1)} disabled={index <= 0} aria-label={t("detail.previous")} title={t("detail.previous")}>
                      <ChevronLeft aria-hidden />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      onClick={() => step(1)}
                      disabled={index < 0 || index >= visible.length - 1}
                      aria-label={t("detail.next")}
                      title={t("detail.next")}
                    >
                      <ChevronRight aria-hidden />
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="min-h-0 flex-1 p-3">
                {!shown ? (
                  <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{t("list.select")}</p>
                ) : !canView ? (
                  <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{t("image.noPermission")}</p>
                ) : !shown.idUsable ? (
                  <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{t("image.noId")}</p>
                ) : (
                  <ImageViewer
                    validationId={shown.id}
                    friendId={shown.friendId || friendId || null}
                    viewerName={viewerName}
                    locale={locale}
                    isAdmin={isAdmin}
                  />
                )}
              </div>
            </div>

            {/* Nothing opened yet: the image pane takes the whole width rather than leaving an empty column beside it. */}
            {shown ? (
              <>
                <PaneResizeHandle
                  width={sidePane.width}
                  min={SIDE_PANE.min}
                  getMax={paneMax}
                  dir={-1}
                  onChange={sidePane.setWidth}
                  onCommit={sidePane.commit}
                  onReset={sidePane.reset}
                  label={t("resizePanel")}
                />

                <div
                  className="flex min-h-0 flex-col border-s border-border lg:w-(--pane-w) lg:flex-none max-lg:border-s-0 max-lg:border-t"
                  style={{ "--pane-w": `${sidePane.width}px` } as CSSProperties}
                >
                  <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 max-lg:overflow-visible">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <TypeChip type={shown.type} />
                      <StatusChip status={shown.status} />
                    </div>
                    {revealError ? <ErrorPanel code={revealError} isAdmin={isAdmin} compact onRetry={() => void reveal()} /> : null}
                    <DataCard v={shown} canReveal={canReveal} revealed={isRevealed} revealing={revealing} onReveal={() => void reveal()} onHide={() => setRevealed(null)} now={now} />
                  </div>
                  <div className="shrink-0 border-t border-border p-3">
                    {status && !canDecide && !shown.review ? <ReadOnlyNotice /> : null}
                    <DecisionPanel
                      v={shown}
                      canDecide={canDecide}
                      friendId={decideFriendId}
                      isAdmin={isAdmin}
                      decide={(decision: KycDecision, note: string, amend: boolean) => postDecision(shown.id, decideFriendId, decision, note, amend)}
                      onDone={decided}
                      onUncertain={() => void refreshOne(shown.id, decideFriendId)}
                    />
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      <footer className="shrink-0 border-t border-border px-4 py-1.5 text-center text-xs text-muted-foreground">
        {t("recordedFooter")}
        {isAdmin && status?.service === undefined && configured && tab === "review" ? (
          <>
            {" · "}
            <button
              type="button"
              onClick={() => void checkConnection()}
              disabled={checking}
              className="underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {checking ? t("setup.checking") : t("setup.checkConnection")}
            </button>
          </>
        ) : null}
        {isAdmin && status?.service ? <> · {status.service === "up" ? t("setup.reachable") : t("setup.unreachable")}</> : null}
      </footer>
    </div>
  );
}
