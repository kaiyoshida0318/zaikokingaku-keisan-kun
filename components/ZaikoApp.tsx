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
  type ReconcileResult,
  type ShipmentRow,
  type SnapshotRow,
} from "@/lib/data";
import { count, dateOnly, dateTime, yen } from "@/lib/format";
import { getSupabaseConfigError, NE_SYNC_WORKER_URL, supabase, ZAIKO_AUTH_STORAGE_KEY } from "@/lib/supabaseClient";
import BrandMark from "./BrandMark";
import SettingsPanel from "./SettingsPanel";
import SyncModal from "./SyncModal";
import { LogsView, ProductsView, ShipmentsView, SnapshotsView, TrendChart } from "./views";

type Tab = "products" | "shipments" | "snapshots" | "logs";

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
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [reauthUrl, setReauthUrl] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);


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
    return {
      value: inStock.reduce((sum, row) => sum + row.valueJpy, 0),
      qty: inStock.reduce((sum, row) => sum + row.qty, 0),
      products: inStock.length,
      review: inStock.filter((row) => row.needsReview).length,
    };
  }, [products]);

  // 前月末（今月1日より前の最新スナップショット）
  const previousMonthEnd = useMemo(() => {
    const monthStart = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 7) + "-01";
    return snapshots.find((row) => row.snapshotDate < monthStart) ?? null;
  }, [snapshots]);
  const lastCheck = snapshots[0] ?? null;

  async function handleReconcile() {
    if (reconciling) return;
    if (seedOpening) {
      const ok = window.confirm(
        "商品DBの全商品について、便がまだない商品をNEの在庫数・原価で「期首在庫」として登録します。\n" +
          "NE APIを商品1000件ごとに2回使います。続けますか？",
      );
      if (!ok) return;
    }
    setReconciling(true);
    setReconcileError(null);
    setReauthUrl(null);
    try {
      const result = await runReconcile(accessToken, seedOpening);
      setReconcileResult(result);
      setSeedOpening(false);
      await loadAll();
    } catch (err) {
      if (err instanceof NeReauthError) setReauthUrl(err.reauthUrl);
      setReconcileError(err instanceof Error ? err.message : "照合に失敗しました。");
    } finally {
      setReconciling(false);
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
  const monthDiff = previousMonthEnd ? totals.value - previousMonthEnd.totalValueJpy : null;

  const metrics = locked ? null : (
    <div className="metric-grid">
      <div className="metric-card metric-card--main">
        <div className="metric-icon">💴</div>
        <div>
          <div className="metric-value">{yen(totals.value)}</div>
          <div className="metric-label">在庫金額（便ごとの原価・先入先出）</div>
        </div>
      </div>
      <div className="metric-card">
        <div className="metric-icon">📦</div>
        <div>
          <div className="metric-value">{count(totals.qty)}</div>
          <div className="metric-label">在庫数</div>
        </div>
      </div>
      <div className="metric-card">
        <div className="metric-icon">🏷</div>
        <div>
          <div className="metric-value">{count(totals.products)}</div>
          <div className="metric-label">在庫のある商品</div>
        </div>
      </div>
      <div className="metric-card crown">
        <div className="metric-icon">📅</div>
        <div>
          <div className="metric-value">
            {monthDiff === null ? "—" : `${monthDiff >= 0 ? "+" : "−"}${yen(Math.abs(monthDiff))}`}
          </div>
          <div className="metric-label">
            前月末比{previousMonthEnd ? `（${dateOnly(previousMonthEnd.snapshotDate)} ${yen(previousMonthEnd.totalValueJpy)}）` : ""}
          </div>
        </div>
      </div>
      <div className={`metric-card ${totals.review > 0 ? "alert" : ""}`}>
        <div className="metric-icon">⚠️</div>
        <div>
          <div className="metric-value">{count(totals.review)}</div>
          <div className="metric-label">要確認の商品</div>
        </div>
      </div>
    </div>
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
      {(tab === "products" || tab === "snapshots") && <TrendChart snapshots={snapshots} />}
    </>
  );

  return (
    <>
      <header className="app-header">
        <div className="brand-group">
          <BrandMark />
          <span className="app-version">v0.1.0</span>
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
            ["shipments", "🚚 便別", locked ? null : shipments.length],
            ["snapshots", "📅 日ごとの記録", locked ? null : snapshots.length],
            ["logs", "🕒 照合ログ", null],
          ] as const
        ).map(([key, label, n]) => (
          <button key={key} type="button" className={`tab-btn ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
            {label}
            {n !== null && <span className="cnt">{count(n)}</span>}
          </button>
        ))}
      </nav>

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
          {tab === "snapshots" && <SnapshotsView snapshots={snapshots} top={top} />}
          {tab === "logs" && <LogsView logs={logs} top={top} />}
        </>
      )}

      <footer className="footer">
        在庫金額 = 各便の残り × その便の1単位原価（単価＋オプション＋中国内運賃＋国際送料）。出荷はNEの在庫数の減少として、古い便から消費します。
      </footer>

      {settingsOpen && (
        <SettingsPanel
          isUnlocked={!locked}
          onLock={() => {
            void handleLogout();
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
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
