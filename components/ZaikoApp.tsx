"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchLogs,
  fetchProducts,
  fetchShipments,
  fetchSnapshots,
  NeReauthError,
  runReconcile,
  type LogRow,
  type ProductRow,
  type ReconcileProgress,
  type ReconcileResult,
  type ShipmentRow,
  type SnapshotRow,
} from "@/lib/data";
import {
  count,
  type CostRounding,
  dateTime,
  DEFAULT_COST_ROUNDING,
  loadCostRounding,
  setCostRounding,
  yen,
} from "@/lib/format";
import { getSupabaseConfigError, NE_SYNC_WORKER_URL, supabase, ZAIKO_AUTH_STORAGE_KEY } from "@/lib/supabaseClient";
import { APP_BUILT_AT, APP_COMMIT, APP_VERSION, fetchNewerVersion, type PublishedVersion } from "@/lib/version";
import BrandMark from "./BrandMark";
import { DEFAULT_PERIOD, type Period } from "./PeriodBar";
import SettingsPanel from "./SettingsPanel";
import SyncModal from "./SyncModal";
import InventorySummary from "./InventorySummary";
import { LogsView, ProductsView, ShipmentsView, SnapshotsView, TrendView } from "./views";

type Tab = "products" | "shipments" | "snapshots" | "trend" | "logs";

export default function ZaikoApp() {
  const [authLoading, setAuthLoading] = useState(true);
  const [accessToken, setAccessToken] = useState("");
  const [email, setEmail] = useState("");

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [shipments, setShipments] = useState<ShipmentRow[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("products");

  const [seedOpening, setSeedOpening] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<ReconcileResult | null>(null);
  const [reconcileProgress, setReconcileProgress] = useState<ReconcileProgress | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [reauthUrl, setReauthUrl] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  // 在庫推移の表示期間（表とグラフで共通）
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD);
  // 原価の小数点の丸め（変えると単価の表示がすべて描き直される）
  const [rounding, setRounding] = useState<CostRounding>(DEFAULT_COST_ROUNDING);
  useEffect(() => {
    const saved = loadCostRounding();
    setCostRounding(saved, false);
    setRounding(saved);
  }, []);
  // 公開中のバージョンが、開いている画面より新しいか（開いたとき・タブに戻ったときに確かめる）
  const [newer, setNewer] = useState<PublishedVersion | null>(null);
  useEffect(() => {
    let lastCheck = 0;
    const check = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastCheck < 60_000) return;
      lastCheck = Date.now();
      void fetchNewerVersion().then((v) => v && setNewer(v));
    };
    check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, []);
  function changeRounding(next: CostRounding) {
    setCostRounding(next);
    setRounding(next);
  }


  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return;
    }
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setAccessToken(data.session?.access_token ?? "");
      setEmail(data.session?.user.email ?? "");
      setAuthLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      setAccessToken(session?.access_token ?? "");
      setEmail(session?.user.email ?? "");
      setAuthLoading(false);
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const results = await Promise.allSettled([fetchProducts(), fetchShipments(), fetchSnapshots(), fetchLogs()]);
    const [p, s, snap, l] = results;
    if (p.status === "fulfilled") setProducts(p.value);
    if (s.status === "fulfilled") setShipments(s.value);
    if (snap.status === "fulfilled") setSnapshots(snap.value);
    if (l.status === "fulfilled") setLogs(l.value);
    const firstError = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    setLoadError(firstError ? (firstError.reason instanceof Error ? firstError.reason.message : String(firstError.reason)) : null);
    setLoadedAt(new Date().toISOString());
    setLoading(false);
  }, []);

  const isLoggedIn = Boolean(accessToken);
  useEffect(() => {
    if (isLoggedIn) void loadAll();
  }, [isLoggedIn, loadAll]);

  const totals = useMemo(() => {
    const inStock = products.filter((row) => row.qty > 0);
    return { value: inStock.reduce((sum, row) => sum + row.valueJpy, 0), products: inStock.length };
  }, [products]);
  const lastCheck = snapshots[0] ?? null;

  async function handleReconcile() {
    if (reconciling) return;
    if (seedOpening) {
      const ok = window.confirm(
        "商品DBの全商品と、NEで在庫がある全商品について、便がまだない商品をNEの在庫数・原価で「旧原価在庫」として登録します。\n" +
          "NE APIを商品1000件ごとに3回ほど使います。続けますか？",
      );
      if (!ok) return;
    }
    setReconciling(true);
    setReconcileProgress(null);
    setReconcileError(null);
    setReauthUrl(null);
    try {
      const result = await runReconcile(accessToken, seedOpening, setReconcileProgress);
      setReconcileResult(result);
      setSeedOpening(false);
      await loadAll();
    } catch (err) {
      if (err instanceof NeReauthError) setReauthUrl(err.reauthUrl);
      setReconcileError(err instanceof Error ? err.message : "照合に失敗しました。");
    } finally {
      setReconciling(false);
      setReconcileProgress(null);
    }
  }

  async function handleLogout() {
    try {
      await supabase?.auth.signOut({ scope: "local" });
    } finally {
      try {
        window.localStorage.removeItem(ZAIKO_AUTH_STORAGE_KEY);
      } catch {
        // ignore
      }
      setAccessToken("");
      setEmail("");
      setProducts([]);
      setShipments([]);
      setSnapshots([]);
      setLogs([]);
      setReconcileResult(null);
      setLoadedAt(null);
    }
  }

  const configError = getSupabaseConfigError();
  const locked = !isLoggedIn;

  const metrics = locked ? null : (
    <InventorySummary products={products} snapshots={snapshots} logs={logs} loadedAt={loadedAt} />
  );

  const top = (
    <>
      {loadError && (
        <div className="banner banner--error">
          {loadError}
          <button type="button" className="text-btn" onClick={() => void loadAll()}>再読み込み</button>
        </div>
      )}
      {metrics}
    </>
  );

  return (
    <>
      <header className="app-header">
        <div className="brand-group">
          <BrandMark />
          <span
            className="app-version"
            title={[
              `バージョン ${APP_VERSION}`,
              APP_BUILT_AT && `ビルド ${dateTime(APP_BUILT_AT)}`,
              APP_COMMIT && `コミット ${APP_COMMIT}`,
            ]
              .filter(Boolean)
              .join("\n")}
          >
            v{APP_VERSION}
            {APP_BUILT_AT && <small>{dateTime(APP_BUILT_AT)}</small>}
          </span>
        </div>
        <div className="header-spacer" />
        <div className="header-actions">
          <span
            className={`conn-pill ${locked ? "off" : "ok"}`}
            title={lastCheck ? `最終照合 ${dateTime(lastCheck.takenAt)}` : undefined}
          >
            {authLoading ? "確認中" : locked ? "キー未入力" : lastCheck ? `照合 ${dateTime(lastCheck.takenAt)}` : "表示中"}
          </span>
          <button type="button" className="btn-icon" onClick={() => setSettingsOpen(true)} title="キーと接続先">
            ⚙ 設定
          </button>
          <button type="button" className="btn-icon" onClick={() => setSyncOpen(true)} title="NEとの照合と画面の更新">
            🔄 照合と更新
          </button>
        </div>
      </header>

      <nav className="tab-bar">
        {(
          [
            ["products", "📦 商品別", locked ? null : totals.products],
            ["snapshots", "📅 在庫推移(表)", locked ? null : snapshots.length],
            ["trend", "📈 在庫推移(グラフ)", null],
            ["shipments", "🚚 入庫履歴", locked ? null : shipments.length],
            ["logs", "🕒 照合ログ", null],
          ] as const
        ).map(([key, label, n]) => (
          <button key={key} type="button" className={`tab-btn ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
            {label}
            {n !== null && <span className="cnt">{count(n)}</span>}
          </button>
        ))}
      </nav>

      {newer && (
        <div className="banner banner--update banner--page">
          新しいバージョン v{newer.version} が公開されています（この画面は v{APP_VERSION}）。
          <button type="button" className="text-btn" onClick={() => window.location.reload()}>
            再読み込みして更新
          </button>
        </div>
      )}
      {configError && <div className="banner banner--error banner--page">{configError}</div>}

      {locked ? (
        <main className="content">
          <div className="panel">
            <div className="empty-state">
              <div className="empty-icon">🔒</div>
              <div className="empty-title">{authLoading ? "確認中…" : "キーを入力するとデータが表示されます"}</div>
              {!authLoading && (
                <>
                  <div className="empty-desc">「⚙ 設定」からキーを入力してください。一度入れれば、このブラウザでは次回からそのまま表示されます。</div>
                  <button type="button" className="btn-primary" onClick={() => setSettingsOpen(true)}>
                    ⚙ 設定を開く
                  </button>
                </>
              )}
            </div>
          </div>
        </main>
      ) : (
        <>
          {tab === "products" && <ProductsView products={products} top={top} />}
          {tab === "shipments" && <ShipmentsView shipments={shipments} top={top} />}
          {tab === "snapshots" && <SnapshotsView snapshots={snapshots} period={period} onPeriodChange={setPeriod} top={top} />}
          {tab === "trend" && <TrendView snapshots={snapshots} period={period} onPeriodChange={setPeriod} top={top} />}
          {tab === "logs" && <LogsView logs={logs} top={top} />}
        </>
      )}


      {settingsOpen && (
        <SettingsPanel
          isUnlocked={!locked}
          onLock={() => {
            void handleLogout();
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
          rounding={rounding}
          onRoundingChange={changeRounding}
        />
      )}
      {syncOpen && (
        <SyncModal
          onClose={() => setSyncOpen(false)}
          locked={locked}
          totalValue={locked ? null : totals.value}
          lastCheckAt={lastCheck?.takenAt ?? null}
          lastCheckSource={lastCheck?.source ?? null}
          loadedAt={loadedAt}
          loading={loading}
          onReload={() => void loadAll()}
          seedOpening={seedOpening}
          onSeedOpeningChange={setSeedOpening}
          reconciling={reconciling}
          reconcileProgress={reconcileProgress}
          onReconcile={() => void handleReconcile()}
          reconcileResult={reconcileResult}
          reconcileError={reconcileError}
          reauthUrl={reauthUrl}
          workerConfigured={Boolean(NE_SYNC_WORKER_URL)}
        />
      )}
    </>
  );
}
