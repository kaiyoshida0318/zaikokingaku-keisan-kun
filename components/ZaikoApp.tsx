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
import LoginPanel from "./LoginPanel";
import { LogsView, ProductsView, ShipmentsView, SnapshotsView, TrendChart } from "./views";

type Tab = "products" | "shipments" | "snapshots" | "logs";
type Theme = "light" | "dark";
const THEME_KEY = "zaiko-kingaku-theme";

function readTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // 保存できない環境
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function ZaikoApp() {
  const [authLoading, setAuthLoading] = useState(true);
  const [accessToken, setAccessToken] = useState("");
  const [email, setEmail] = useState("");
  // null = まだ読み込んでいない（読み込む前に保存して上書きしないため）
  const [theme, setTheme] = useState<Theme | null>(null);

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

  useEffect(() => {
    setTheme(readTheme());
  }, []);
  useEffect(() => {
    if (!theme) return;
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // 保存できなくても表示は切り替わる
    }
  }, [theme]);

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
    }
  }

  const configError = getSupabaseConfigError();
  if (configError) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <BrandMark />
          <p className="auth-error">{configError}</p>
        </div>
      </main>
    );
  }
  if (authLoading) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <BrandMark />
          <p className="muted">ログイン状態を確認中…</p>
        </div>
      </main>
    );
  }
  if (!isLoggedIn) return <LoginPanel />;

  const monthDiff = previousMonthEnd ? totals.value - previousMonthEnd.totalValueJpy : null;

  return (
    <main className="shell">
      <header className="topbar">
        <BrandMark compact />
        <div className="topbar-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            aria-label={theme === "dark" ? "ライトモードにする" : "ダークモードにする"}
            title={theme === "dark" ? "ライトモード" : "ダークモード"}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <span className="user" title={email}>{email}</span>
          <button type="button" className="button button--ghost" onClick={handleLogout}>
            ログアウト
          </button>
        </div>
      </header>

      <section className="hero">
        <div className="hero-main">
          <p className="eyebrow">在庫金額（便ごとの原価・先入先出）</p>
          <p className="hero-value">{yen(totals.value)}</p>
          <p className="hero-sub">
            {lastCheck ? `最終照合 ${dateTime(lastCheck.takenAt)}（${lastCheck.source === "cron" ? "自動" : "手動"}）` : "まだNEと照合していません"}
            {loadedAt && <span>　表示 {dateTime(loadedAt)}</span>}
          </p>
          <dl className="kpis">
            <div>
              <dt>在庫数</dt>
              <dd>{count(totals.qty)}<small>個</small></dd>
            </div>
            <div>
              <dt>商品数</dt>
              <dd>{count(totals.products)}</dd>
            </div>
            <div>
              <dt>前月末</dt>
              <dd>
                {previousMonthEnd ? yen(previousMonthEnd.totalValueJpy) : "—"}
                {monthDiff !== null && (
                  <small className={monthDiff >= 0 ? "up" : "down"}>
                    {monthDiff >= 0 ? "+" : "−"}
                    {yen(Math.abs(monthDiff))}
                  </small>
                )}
              </dd>
            </div>
            <div className={totals.review > 0 ? "kpi-warn" : ""}>
              <dt>要確認</dt>
              <dd>{count(totals.review)}</dd>
            </div>
          </dl>
        </div>

        <div className="hero-side">
          <div className="sync-card">
            <h2>NEと照合</h2>
            <p>
              NEの在庫数と比べて、減った分を古い便から消費し、今日の在庫金額を記録します。毎日 03:20 にも自動で実行されます。
            </p>
            <label className="check">
              <input type="checkbox" checked={seedOpening} onChange={(e) => setSeedOpening(e.target.checked)} />
              便のない商品も期首在庫として登録（初回のみ）
            </label>
            <button
              type="button"
              className="button button--primary button--wide"
              onClick={handleReconcile}
              disabled={reconciling || !NE_SYNC_WORKER_URL}
            >
              {reconciling ? "照合中…（商品数が多いと1分ほど）" : "NEと照合"}
            </button>
            {!NE_SYNC_WORKER_URL && <p className="sync-error">NEXT_PUBLIC_NE_SYNC_WORKER_URL が未設定です。</p>}
            {reconcileError && (
              <p className="sync-error">
                {reconcileError}
                {reauthUrl && (
                  <>
                    {" "}
                    <a href={reauthUrl} target="_blank" rel="noreferrer">NE認証をやり直す</a>
                  </>
                )}
              </p>
            )}
            {reconcileResult && !reconcileError && (
              <p className="sync-result">
                {count(reconcileResult.checkedCount)}商品を照合
                {reconcileResult.consumedTotal > 0 && `／古い便から${count(reconcileResult.consumedTotal)}個消費`}
                {reconcileResult.openingProducts > 0 && `／期首在庫 ${count(reconcileResult.openingProducts)}商品`}
                {reconcileResult.adjustedProducts > 0 && `／在庫増の調整 ${count(reconcileResult.adjustedProducts)}商品`}
                {reconcileResult.notFoundCount > 0 && `／NEにない商品 ${count(reconcileResult.notFoundCount)}件`}
              </p>
            )}
          </div>
        </div>
      </section>

      <TrendChart snapshots={snapshots} />

      {loadError && (
        <p className="banner banner--error">
          {loadError}
          <button type="button" className="link" onClick={() => void loadAll()}>再読み込み</button>
        </p>
      )}

      <nav className="tabs" aria-label="表示切替">
        {(
          [
            ["products", "商品別", totals.products],
            ["shipments", "便別", shipments.length],
            ["snapshots", "日ごとの記録", snapshots.length],
            ["logs", "照合ログ", null],
          ] as const
        ).map(([key, label, n]) => (
          <button key={key} type="button" className={tab === key ? "is-active" : ""} onClick={() => setTab(key)}>
            {label}
            {n !== null && <span>{count(n)}</span>}
          </button>
        ))}
        <button type="button" className="tabs-reload link" onClick={() => void loadAll()} disabled={loading}>
          {loading ? "読み込み中…" : "最新にする"}
        </button>
      </nav>

      <section className="panel">
        {tab === "products" && <ProductsView products={products} />}
        {tab === "shipments" && <ShipmentsView shipments={shipments} />}
        {tab === "snapshots" && <SnapshotsView snapshots={snapshots} />}
        {tab === "logs" && <LogsView logs={logs} />}
      </section>

      <footer className="footer">
        在庫金額 = 各便の残り × その便の1単位原価（単価＋オプション＋中国内運賃＋国際送料）。
        出荷はNEの在庫数の減少として、古い便から消費します。前月末は {previousMonthEnd ? dateOnly(previousMonthEnd.snapshotDate) : "—"} の記録です。
      </footer>
    </main>
  );
}
