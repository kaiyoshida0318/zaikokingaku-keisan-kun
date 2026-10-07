"use client";

import { useMemo } from "react";
import { MULTI_STORE, sortStores, UNSET_STORE, type LogRow, type ProductRow, type SnapshotRow } from "@/lib/data";
import { count, dateTime, unitYen, yen } from "@/lib/format";
import { storeTone } from "./views";

type StoreTotal = { store: string; v: number; q: number; n: number };

/** 画面上部の在庫金額カード（店舗別の内訳・いつ時点の金額か）と、商品コード数・総在庫数・平均原価のカード */
export default function InventorySummary({
  products,
  snapshots,
  logs,
  loadedAt,
}: {
  products: ProductRow[];
  snapshots: SnapshotRow[];
  logs: LogRow[];
  loadedAt: string | null;
}) {
  const totals = useMemo(() => {
    const inStock = products.filter((row) => row.qty > 0);
    // 店舗別（在庫のある商品）
    const byStore = new Map<string, { v: number; q: number; n: number }>();
    for (const row of inStock) {
      const t = byStore.get(row.store) ?? { v: 0, q: 0, n: 0 };
      t.v += row.valueJpy;
      t.q += row.qty;
      t.n += 1;
      byStore.set(row.store, t);
    }
    // 店舗の色は商品一覧のバッジと揃える（全商品での並び順）
    const allValue = new Map<string, number>();
    for (const row of products) allValue.set(row.store, (allValue.get(row.store) ?? 0) + row.valueJpy);
    return {
      value: inStock.reduce((sum, row) => sum + row.valueJpy, 0),
      qty: inStock.reduce((sum, row) => sum + row.qty, 0),
      products: inStock.length,
      stores: sortStores(byStore.keys(), (store) => byStore.get(store)?.v ?? 0).map((store) => ({
        store,
        ...byStore.get(store)!,
      })),
      colorOrder: sortStores(allValue.keys(), (store) => allValue.get(store) ?? 0),
    };
  }, [products]);

  // いつ時点の金額か：最後の照合と、そのあとの入庫一括での便の登録のうち新しいほう
  const asOf = useMemo(() => {
    const lastCheck = snapshots[0] ?? null;
    const receipt = logs.find((row) => row.event === "receipt" || row.event === "backfill") ?? null;
    const checkAt = lastCheck?.takenAt ?? null;
    if (receipt && (!checkAt || receipt.loggedAt > checkAt)) {
      return { at: receipt.loggedAt, label: "入庫一括で便を登録", checkAt };
    }
    if (checkAt) {
      return { at: checkAt, label: lastCheck?.source === "cron" ? "毎日の自動照合" : "手動で照合", checkAt: null };
    }
    return null;
  }, [logs, snapshots]);

  // 右のカードの内訳は実際の店舗だけ（「複数」「未設定」は出さない）
  const namedStores = totals.stores.filter((t) => t.store !== UNSET_STORE && t.store !== MULTI_STORE);
  const showStores = totals.stores.length > 1 || (totals.stores.length === 1 && totals.stores[0].store !== UNSET_STORE);

  return (
    <div className="metric-grid">
      <section className="metric-card metric-card--main" aria-label="在庫金額">
        <div className="main-head">
          <div className="main-title">
            <span className="main-icon" aria-hidden="true">💴</span>
            在庫金額
            <small>便ごとの原価・先入先出</small>
          </div>
          <div className="main-asof" title={loadedAt ? `画面の読み込み ${dateTime(loadedAt)}` : undefined}>
            {asOf ? (
              <>
                <b>{dateTime(asOf.at)}</b> 時点
                <small>
                  {asOf.label}
                  {asOf.checkAt && `（最終照合 ${dateTime(asOf.checkAt)}）`}
                </small>
              </>
            ) : (
              <small>まだ照合していません</small>
            )}
          </div>
        </div>
        <div className="main-value">{yen(totals.value)}</div>
        {showStores && (
          <>
            <div className="store-stack" aria-hidden="true">
              {totals.stores.map((t) => (
                <span
                  key={t.store}
                  className={`store-stack-seg tone-${storeTone(t.store, totals.colorOrder)}`}
                  style={{ flexGrow: Math.max(t.v, 0) }}
                  title={`${t.store} ${yen(t.v)}`}
                />
              ))}
            </div>
            <ul className="store-rows">
              {totals.stores.map((t) => (
                <li key={t.store}>
                  <span className={`store-dot tone-${storeTone(t.store, totals.colorOrder)}`} aria-hidden="true" />
                  <span className="store-row-name" title={t.store}>{t.store}</span>
                  <span className="store-row-value">{yen(t.v)}</span>
                  <span className="store-row-share">
                    {totals.value > 0 ? ((t.v / totals.value) * 100).toFixed(1) : "0.0"}%
                  </span>
                  <span className="store-row-meta">
                    {count(t.q)}個・{count(t.n)}商品
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section className="metric-card metric-side" aria-label="商品コード数・総在庫数・平均原価">
        {(
          [
            ["🏷", "商品コード数", count(totals.products), (t: StoreTotal) => count(t.n)],
            ["📦", "総在庫数", count(totals.qty), (t: StoreTotal) => count(t.q)],
            [
              "💹",
              "平均原価",
              unitYen(totals.qty > 0 ? totals.value / totals.qty : null),
              (t: StoreTotal) => unitYen(t.q > 0 ? t.v / t.q : null),
            ],
          ] as const
        ).map(([icon, label, value, pick]) => (
          <div key={label} className="side-row">
            <div className="side-label">
              <span aria-hidden="true">{icon}</span>
              {label}
            </div>
            <div className="side-value">{value}</div>
            {namedStores.length > 0 && (
              <div className="side-stores">
                {namedStores.map((t) => (
                  <span key={t.store} className="side-store">
                    <span className={`store-dot tone-${storeTone(t.store, totals.colorOrder)}`} aria-hidden="true" />
                    {t.store}
                    <b>{pick(t)}</b>
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
