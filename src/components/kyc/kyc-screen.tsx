"use client";

// ============================================================
// KYC review (phase 1, read-only): search a friend id, read the validations the ID verification back end holds for it, open an ID image, and (with
// kyc.reveal) reveal the masked values for two minutes. Administrators and owners also get the Access log tab.
//
// What the browser holds: the MASKED list the server sent, and, for at most two minutes, the one validation the reviewer revealed. Nothing is stored
// except the friend ids of recent searches (per person, in this browser, no data). The revealed copy is dropped when the reviewer opens another
// validation, searches again, leaves the tab, hides the page or two minutes pass.
// ============================================================

import { ArrowLeft, Search, ShieldCheck, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { NoAccess } from "@/components/auth/no-access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth, useCapability } from "@/hooks/use-auth";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { FRIEND_ID_RE, normaliseFriendId, type KycStatus, type KycValidation } from "@/lib/kyc/types";

import { AccessLogPanel } from "./access-log";
import { getStatus, getValidations } from "./api";
import { REVEAL_MS, addRecent, loadRecent, revealExpired, saveRecent } from "./helpers";
import { ImageViewer } from "./image-viewer";
import { DataCard, ErrorPanel, ProvisionalNote, ReadOnlyNotice, SetupNotice, StatusChip, TypeChip, UatBanner, ValidationList, rowKey } from "./parts";

type Tab = "review" | "log";
type Phase = "idle" | "loading" | "ready" | "error";

interface Revealed {
  key: string;
  item: KycValidation;
  until: number;
}

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
  const [phase, setPhase] = useState<Phase>("idle");
  const [nextBeforeId, setNextBeforeId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const started = useRef(false);
  const [errorCode, setErrorCode] = useState<string>("");
  const [items, setItems] = useState<KycValidation[]>([]);
  const [fallback, setFallback] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStatus();
  }, [loadStatus]);
  useEffect(() => {
    // localStorage is not readable during the server render, so the recent searches are read once the person is known
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecent(loadRecent(browserStorage(), userId, (v) => FRIEND_ID_RE.test(v)));
  }, [userId]);

  const checkConnection = async () => {
    setChecking(true);
    const res = await getStatus(true);
    setChecking(false);
    if (res.ok) setStatus(res.data);
    else setStatusError(res.code);
  };

  // ---- the search ----
  const run = useCallback(
    async (id: string, reload: boolean) => {
      const mine = ++seq.current;
      setFriendId(id);
      setPhase("loading");
      setErrorCode("");
      openKey.current = null;
      setSelectedKey(null);
      setRevealed(null);
      setRevealError(null);
      setMobilePane("list");
      const res = await getValidations(id, { reload });
      if (mine !== seq.current) return;
      if (!res.ok) {
        setPhase("error");
        setErrorCode(res.code);
        setItems([]);
        return;
      }
      setItems(res.data.items);
      setNextBeforeId(res.data.nextBeforeId);
      setFallback(res.data.fallback);
      setPhase("ready");
    },
    [],
  );

  // The page opens on the latest checks of everybody, so nobody has to know a friend id to start.
  useEffect(() => {
    if (started.current || !status?.configured || !canMenu) return;
    started.current = true;
    // load-on-mount fetch whose result sets state
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run("", false);
  }, [status?.configured, canMenu, run]);

  const loadMore = async () => {
    if (!nextBeforeId || loadingMore || phase !== "ready") return;
    const mine = seq.current;
    setLoadingMore(true);
    const res = await getValidations(friendId, { reload: true, beforeId: nextBeforeId });
    setLoadingMore(false);
    if (mine !== seq.current) return;
    if (!res.ok) {
      setErrorCode(res.code);
      setPhase("error");
      return;
    }
    setItems((cur) => {
      const have = new Set(cur.map((v) => v.id).filter(Boolean));
      return [...cur, ...res.data.items.filter((v) => !v.id || !have.has(v.id))];
    });
    setNextBeforeId(res.data.nextBeforeId);
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const id = normaliseFriendId(draft);
    if (id === "") {
      setDraftInvalid(false);
      void run("", false);
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
    void run(id, false);
  };

  const clear = () => {
    setDraft("");
    setDraftInvalid(false);
    void run("", false);
  };

  const searchRecent = (id: string) => {
    setDraft(id);
    setDraftInvalid(false);
    const next = addRecent(recent, id);
    setRecent(next);
    saveRecent(browserStorage(), userId, next);
    void run(id, false);
  };

  const clearRecent = () => {
    setRecent([]);
    saveRecent(browserStorage(), userId, []);
  };

  // ---- selection and focus ----
  const selected = useMemo(() => {
    const i = items.findIndex((v, idx) => rowKey(v, idx) === selectedKey);
    return i >= 0 ? items[i] : null;
  }, [items, selectedKey]);

  const select = (v: KycValidation, index: number) => {
    setRevealed(null);
    setRevealError(null);
    focusDetail.current = true;
    openKey.current = rowKey(v, index);
    setSelectedKey(rowKey(v, index));
    setMobilePane("detail");
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

  // ---- render ----
  if (!canMenu) return <NoAccess />;

  const isAdmin = status?.isAdmin ?? false;
  const canView = status?.canView ?? false;
  const canReveal = status?.canReveal ?? false;
  const configured = status?.configured ?? false;

  const shown: KycValidation | null = selected && revealed && revealed.key === selectedKey && !revealExpired(revealed.until, now) ? revealed.item : selected;
  const isRevealed = shown !== null && shown === revealed?.item;

  return (
    <div className="mx-auto max-w-[1200px] space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="size-5 text-muted-foreground" aria-hidden />
        <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
        {status?.uat ? <span className="rounded-full bg-[color:light-dark(#fef3c7,#78350f66)] px-2 py-0.5 text-xs font-medium text-[light-dark(#92400e,#fcd34d)]">UAT</span> : null}
      </div>

      <ReadOnlyNotice />
      {status?.uat ? <UatBanner /> : null}

      {isAdmin ? (
        <div role="tablist" aria-label={t("tabs.label")} className="flex gap-1 border-b border-border">
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
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                tab === key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`tabs.${key}`)}
            </button>
          ))}
        </div>
      ) : null}

      {statusError && !status ? <ErrorPanel code={statusError} isAdmin={false} onRetry={() => void loadStatus()} /> : null}

      {status && !configured ? <SetupNotice status={status} /> : null}

      {tab === "log" && isAdmin ? (
        <div role="tabpanel" id="kyc-panel-log" aria-labelledby="kyc-tab-log">
          <AccessLogPanel />
        </div>
      ) : null}

      {tab === "review" && status && configured ? (
        <div role={isAdmin ? "tabpanel" : undefined} id="kyc-panel-review" aria-labelledby={isAdmin ? "kyc-tab-review" : undefined} className="space-y-4">
          {isAdmin && fallback ? <ProvisionalNote /> : null}

          <form onSubmit={submit} role="search" aria-label={t("search.label")} className="rounded-xl border border-border bg-card p-3">
            <label htmlFor="kyc-friend-id" className="mb-1 block text-sm font-medium text-foreground">
              {t("search.label")}
            </label>
            <div className="flex flex-wrap gap-2">
              <div className="relative min-w-0 flex-1 basis-56">
                <Input
                  id="kyc-friend-id"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    if (draftInvalid) setDraftInvalid(false);
                  }}
                  placeholder={t("search.placeholder")}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  maxLength={200}
                  aria-invalid={draftInvalid || undefined}
                  aria-describedby={draftInvalid ? "kyc-friend-id-error" : "kyc-friend-id-hint"}
                  className="pr-8"
                />
                {draft ? (
                  <button type="button" onClick={clear} aria-label={t("search.clear")} title={t("search.clear")} className="absolute inset-y-0 right-1 my-auto flex size-6 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                    <X className="size-4" aria-hidden />
                  </button>
                ) : null}
              </div>
              <Button type="submit" disabled={phase === "loading"}>
                <Search aria-hidden />
                {t("search.button")}
              </Button>
            </div>
            {draftInvalid ? (
              <p id="kyc-friend-id-error" role="alert" className="mt-1 text-xs text-destructive">
                {t("search.invalid")}
              </p>
            ) : (
              <p id="kyc-friend-id-hint" className="mt-1 text-xs text-muted-foreground">
                {t("search.hint")}
              </p>
            )}
            {recent.length > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{t("search.recent")}</span>
                {recent.map((id) => (
                  <button key={id} type="button" onClick={() => searchRecent(id)} className="rounded-full border border-border px-2 py-0.5 font-mono text-xs text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
                    {id}
                  </button>
                ))}
                <button type="button" onClick={clearRecent} className="text-xs text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                  {t("search.clearRecent")}
                </button>
              </div>
            ) : null}
          </form>

          <div className="grid gap-4 md:grid-cols-[minmax(280px,380px)_minmax(0,1fr)]">
            <section aria-labelledby="kyc-results-title" className={cn("min-w-0", mobilePane === "detail" && "max-md:hidden")}>
              <h2 id="kyc-results-title" ref={listRef} tabIndex={-1} className="mb-2 text-sm font-medium text-foreground outline-none">
                {friendId ? t("list.forFriend", { id: friendId }) : t("list.latest")}
              </h2>
              <div aria-live="polite">
                {phase === "idle" ? <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{t("list.start")}</p> : null}
                {phase === "loading" ? (
                  <div role="status" className="space-y-2" aria-busy="true">
                    <span className="sr-only">{t("list.loading")}</span>
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="h-14 animate-pulse rounded-xl bg-muted" />
                    ))}
                  </div>
                ) : null}
                {phase === "error" ? <ErrorPanel code={errorCode} isAdmin={isAdmin} onRetry={() => void run(friendId, true)} /> : null}
                {phase === "ready" && items.length === 0 ? <p className="rounded-xl border border-dashed border-border p-4 text-sm text-foreground">{t("list.empty")}</p> : null}
                {phase === "ready" && items.length > 0 ? (
                  <>
                    <p className="mb-1 text-xs text-muted-foreground">{t("list.count", { count: items.length })}</p>
                    <ValidationList items={items} selectedKey={selectedKey} onSelect={select} now={now} />
                    {nextBeforeId ? (
                      <Button type="button" variant="outline" className="mt-2 w-full" onClick={() => void loadMore()} disabled={loadingMore}>
                        {loadingMore ? t("list.loadingMore") : t("list.loadMore")}
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
            </section>

            <section aria-labelledby="kyc-detail-title" className={cn("min-w-0 space-y-3", mobilePane === "list" && "max-md:hidden")}>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon-sm" onClick={back} aria-label={t("detail.back")} title={t("detail.back")} className="md:hidden">
                  <ArrowLeft aria-hidden />
                </Button>
                <h2 id="kyc-detail-title" ref={detailRef} tabIndex={-1} className="text-sm font-medium text-foreground outline-none">
                  {t("detail.heading")}
                </h2>
              </div>
              {!shown ? (
                <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{t("list.select")}</p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <TypeChip type={shown.type} />
                    <StatusChip status={shown.status} />
                  </div>
                  {canView ? (
                    shown.idUsable ? (
                      <ImageViewer key={shown.id} validationId={shown.id} friendId={shown.friendId || friendId || null} viewerName={viewerName} locale={locale} isAdmin={isAdmin} />
                    ) : (
                      <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{t("image.noId")}</p>
                    )
                  ) : (
                    <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{t("image.noPermission")}</p>
                  )}
                  {revealError ? <ErrorPanel code={revealError} isAdmin={isAdmin} compact onRetry={() => void reveal()} /> : null}
                  <DataCard v={shown} canReveal={canReveal} revealed={isRevealed} revealing={revealing} onReveal={() => void reveal()} onHide={() => setRevealed(null)} now={now} />
                </>
              )}
            </section>
          </div>
        </div>
      ) : null}

      <p className="text-center text-xs text-muted-foreground">{t("recordedFooter")}</p>
      {isAdmin && status?.service === undefined && configured && tab === "review" ? (
        <p className="text-center">
          <button type="button" onClick={() => void checkConnection()} disabled={checking} className="text-xs text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            {checking ? t("setup.checking") : t("setup.checkConnection")}
          </button>
        </p>
      ) : null}
      {isAdmin && status?.service ? <p className="text-center text-xs text-muted-foreground">{status.service === "up" ? t("setup.reachable") : t("setup.unreachable")}</p> : null}
    </div>
  );
}
