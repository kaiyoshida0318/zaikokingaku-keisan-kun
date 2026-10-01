"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  fetchLots,
  fetchSnapshotItems,
  type LogRow,
  type LotRow,
  type ProductRow,
  type ShipmentRow,
  type SnapshotRow,
} from "@/lib/data";
import {
  count,
  csvBlob,
  dateOnly,
  dateTime,
  downloadBlob,
  shipmentLabel,
  todayJst,
  unitYen,
  yen,
} from "@/lib/format";

/* ------------------------------------------------------------------ */
/* 推移グラフ                                                           */
/* ------------------------------------------------------------------ */

export function TrendChart({ snapshots }: { snapshots: SnapshotRow[] }) {
  const points = useMemo(
    () => [...snapshots].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate)).slice(-120),
    [snapshots],
  );
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <div className="trend trend--empty">
        <p>在庫金額の推移は、照合が2日分以上たまると表示されます（毎日 03:20 に自動で照合します）。</p>
      </div>
    );
  }

  const W = 800;
  const H = 170;
  const padX = 8;
  const padTop = 14;
  const padBottom = 22;
  const values = points.map((p) => p.totalValueJpy);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || Math.max(max, 1) * 0.1;
  const lo = Math.max(0, min - span * 0.15);
  const hi = max + span * 0.15;
  const x = (i: number) => padX + (i * (W - padX * 2)) / (points.length - 1);
  const y = (v: number) => padTop + (1 - (v - lo) / (hi - lo)) * (H - padTop - padBottom);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.totalValueJpy).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - padBottom} L${x(0).toFixed(1)},${H - padBottom} Z`;
  const active = hover !== null ? points[hover] : points[points.length - 1];
  const activeIndex = hover ?? points.length - 1;

  return (
    <div className="trend">
      <div className="trend-head">
        <span>在庫金額の推移</span>
        <strong>
          {dateOnly(active.snapshotDate)}　{yen(active.totalValueJpy)}
        </strong>
      </div>
      <svg
        className="trend-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="在庫金額の推移"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / rect.width;
          const index = Math.round(ratio * (points.length - 1));
          setHover(Math.min(points.length - 1, Math.max(0, index)));
        }}
      >
        <path className="trend-area" d={area} />
        <path className="trend-line" d={line} vectorEffect="non-scaling-stroke" />
        <line
          className="trend-cursor"
          x1={x(activeIndex)}
          x2={x(activeIndex)}
          y1={padTop}
          y2={H - padBottom}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="trend-axis">
        <span>{dateOnly(points[0].snapshotDate)}</span>
        <span>{dateOnly(points[points.length - 1].snapshotDate)}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 商品別                                                               */
/* ------------------------------------------------------------------ */

type ProductFilter = "stock" | "all" | "review";
type ProductSort = "value" | "qty" | "code";

export function ProductsView({ products }: { products: ProductRow[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProductFilter>("stock");
  const [sort, setSort] = useState<ProductSort>("value");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(200);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = products.filter((row) => {
      if (filter === "stock" && row.qty <= 0) return false;
      if (filter === "review" && !row.needsReview) return false;
      if (!q) return true;
      return row.productCodeLc.includes(q) || row.productName.toLowerCase().includes(q);
    });
    return filtered.sort((a, b) => {
      if (sort === "qty") return b.qty - a.qty || a.productCodeLc.localeCompare(b.productCodeLc);
      if (sort === "code") return a.productCodeLc.localeCompare(b.productCodeLc);
      return b.valueJpy - a.valueJpy || a.productCodeLc.localeCompare(b.productCodeLc);
    });
  }, [products, query, filter, sort]);

  const totalValue = rows.reduce((sum, row) => sum + row.valueJpy, 0);
  const totalQty = rows.reduce((sum, row) => sum + row.qty, 0);
  const reviewCount = products.filter((row) => row.needsReview).length;

  function exportCsv() {
    downloadBlob(
      csvBlob(
        ["商品コード", "商品名", "在庫数", "在庫金額", "平均原価", "最新の便の原価", "残っている便の数", "要確認"],
        rows.map((row) => [
          row.productCode,
          row.productName,
          row.qty,
          Math.round(row.valueJpy),
          row.avgUnitCost ?? "",
          row.latestUnitCost ?? "",
          row.openLots,
          row.needsReview ? "要確認" : "",
        ]),
      ),
      `在庫金額_商品別_${todayJst()}.csv`,
    );
  }

  return (
    <div className="view">
      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="商品コード・商品名で検索"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(200);
          }}
        />
        <div className="segmented" role="group" aria-label="絞り込み">
          {(
            [
              ["stock", "在庫あり"],
              ["all", "すべて"],
              ["review", `要確認${reviewCount ? ` ${reviewCount}` : ""}`],
            ] as const
          ).map(([key, label]) => (
            <button key={key} type="button" className={filter === key ? "is-active" : ""} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>
        <select className="select" value={sort} onChange={(event) => setSort(event.target.value as ProductSort)} aria-label="並び順">
          <option value="value">金額の大きい順</option>
          <option value="qty">在庫数の多い順</option>
          <option value="code">商品コード順</option>
        </select>
        <button type="button" className="button" onClick={exportCsv} disabled={rows.length === 0}>
          CSV出力
        </button>
      </div>

      <p className="view-summary">
        {count(rows.length)}商品　在庫 {count(totalQty)}個　<strong>{yen(totalValue)}</strong>
      </p>

      {rows.length === 0 ? (
        <p className="empty">
          {products.length === 0
            ? "まだ便ごとの在庫がありません。入庫一括でNE更新すると登録されます。今ある在庫をまとめて登録するには「NEと照合」で「便のない商品も期首在庫として登録」を選んでください。"
            : "条件に合う商品がありません。"}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>商品コード</th>
                <th>商品名</th>
                <th className="num">在庫数</th>
                <th className="num">在庫金額</th>
                <th className="num">平均原価</th>
                <th className="num">最新の便の原価</th>
                <th className="num">便</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((row) => {
                const isOpen = expanded === row.productCodeLc;
                return (
                  <Fragment key={row.productCodeLc}>
                    <tr
                      className={`row-clickable ${isOpen ? "is-open" : ""}`}
                      onClick={() => setExpanded(isOpen ? null : row.productCodeLc)}
                    >
                      <td className="code">
                        <span className="chevron" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                        {row.productCode}
                      </td>
                      <td className="name">{row.productName}</td>
                      <td className="num">{count(row.qty)}</td>
                      <td className="num strong">{yen(row.valueJpy)}</td>
                      <td className="num">{unitYen(row.avgUnitCost)}</td>
                      <td className="num">{unitYen(row.latestUnitCost)}</td>
                      <td className="num">{row.openLots}</td>
                      <td>{row.needsReview ? <span className="badge badge--warn">要確認</span> : null}</td>
                    </tr>
                    {isOpen && (
                      <tr className="detail-row">
                        <td colSpan={8}>
                          <LotDetail productCodeLc={row.productCodeLc} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {rows.length > limit && (
            <button type="button" className="more" onClick={() => setLimit((v) => v + 500)}>
              さらに表示（残り {count(rows.length - limit)}件）
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const lotTypeLabel: Record<LotRow["lotType"], string> = {
  shipment: "便",
  opening: "期首在庫",
  adjust: "在庫増の調整",
};

function LotDetail({ productCodeLc }: { productCodeLc: string }) {
  const [lots, setLots] = useState<LotRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showUsed, setShowUsed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchLots(productCodeLc)
      .then((rows) => alive && setLots(rows))
      .catch((err) => alive && setError(err instanceof Error ? err.message : "読み込みに失敗しました。"));
    return () => {
      alive = false;
    };
  }, [productCodeLc]);

  if (error) return <p className="detail-error">{error}</p>;
  if (!lots) return <p className="detail-loading">便を読み込み中…</p>;

  const visible = showUsed ? lots : lots.filter((lot) => lot.qtyRemaining > 0);
  const usedCount = lots.length - lots.filter((lot) => lot.qtyRemaining > 0).length;

  return (
    <div className="detail">
      <div className="detail-head">
        <span>新しい順。出荷はいちばん下（古い便）から消費されます。</span>
        {usedCount > 0 && (
          <button type="button" className="link" onClick={() => setShowUsed((v) => !v)}>
            {showUsed ? "使い切った便を隠す" : `使い切った便も表示（${usedCount}）`}
          </button>
        )}
      </div>
      <table className="table table--inner">
        <thead>
          <tr>
            <th>種類</th>
            <th>便</th>
            <th>登録日</th>
            <th className="num">入庫数</th>
            <th className="num">残り</th>
            <th className="num">1単位原価</th>
            <th className="num">商品</th>
            <th className="num">オプション</th>
            <th className="num">国内運賃</th>
            <th className="num">国際送料</th>
            <th className="num">残り金額</th>
            <th>メモ</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((lot) => (
            <tr key={lot.id} className={lot.qtyRemaining === 0 ? "is-used" : ""}>
              <td>
                {lotTypeLabel[lot.lotType]}
                {lot.needsReview && <span className="badge badge--warn">要確認</span>}
              </td>
              <td>{lot.lotType === "shipment" ? shipmentLabel(lot.shipmentId) : "—"}</td>
              <td>{dateOnly(lot.receivedAt)}</td>
              <td className="num">{count(lot.qtyIn)}</td>
              <td className="num strong">{count(lot.qtyRemaining)}</td>
              <td className="num strong">{unitYen(lot.unitCost)}</td>
              <td className="num">{unitYen(lot.unitGoods)}</td>
              <td className="num">{unitYen(lot.unitOption)}</td>
              <td className="num">{unitYen(lot.unitDomestic)}</td>
              <td className="num">{unitYen(lot.unitIntl === null && lot.unitOther === null ? null : (lot.unitIntl ?? 0) + (lot.unitOther ?? 0))}</td>
              <td className="num">{yen(lot.qtyRemaining * (lot.unitCost ?? 0))}</td>
              <td className="note">{lot.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 便別                                                                 */
/* ------------------------------------------------------------------ */

export function ShipmentsView({ shipments }: { shipments: ShipmentRow[] }) {
  if (shipments.length === 0) {
    return <p className="empty">まだ便が登録されていません。入庫一括でNE更新すると、配送依頼書ごとに登録されます。</p>;
  }
  return (
    <div className="view">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>便</th>
              <th>配送依頼書</th>
              <th>登録日</th>
              <th className="num">レート</th>
              <th className="num">合計原価</th>
              <th className="num">国際送料</th>
              <th>国際送料の配分</th>
              <th className="num">残り / 入庫</th>
              <th className="num">残り金額</th>
              <th>状態</th>
            </tr>
          </thead>
          <tbody>
            {shipments.map((row) => {
              const ratio = row.qtyIn > 0 ? row.qtyRemaining / row.qtyIn : 0;
              return (
                <tr key={row.shipmentId}>
                  <td className="code">{shipmentLabel(row.shipmentId)}</td>
                  <td className="muted">{row.shipmentId}</td>
                  <td>{dateOnly(row.processedAt)}</td>
                  <td className="num">{row.rate}</td>
                  <td className="num">{yen(row.totalJpy)}</td>
                  <td className="num">
                    {yen(row.intlFreightJpy)}
                    {row.chargeableKg > 0 && <small> / {row.chargeableKg}kg</small>}
                  </td>
                  <td>{row.intlMethod === "box" ? "箱の決済重量" : row.intlMethod === "value" ? "商品代金の比率" : "—"}</td>
                  <td className="num">
                    <span className="meter" aria-hidden="true">
                      <span style={{ width: `${Math.round(ratio * 100)}%` }} />
                    </span>
                    {count(row.qtyRemaining)} / {count(row.qtyIn)}
                  </td>
                  <td className="num strong">{yen(row.valueRemainingJpy)}</td>
                  <td>
                    {row.unallocatedJpy > 0.5 && <span className="badge badge--danger">未割当 {yen(row.unallocatedJpy)}</span>}
                    {row.needsReview && <span className="badge badge--warn">要確認</span>}
                    {row.qtyIn > 0 && row.qtyRemaining === 0 && <span className="badge">使い切り</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* スナップショット                                                     */
/* ------------------------------------------------------------------ */

export function SnapshotsView({ snapshots }: { snapshots: SnapshotRow[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [monthEndOnly, setMonthEndOnly] = useState(false);

  const rows = useMemo(() => {
    if (!monthEndOnly) return snapshots;
    // 各月の最後の日付だけ
    const seen = new Set<string>();
    return snapshots.filter((row) => {
      const month = row.snapshotDate.slice(0, 7);
      if (seen.has(month)) return false;
      seen.add(month);
      return true;
    });
  }, [snapshots, monthEndOnly]);

  async function download(date: string) {
    setBusy(date);
    setError(null);
    try {
      const items = await fetchSnapshotItems(date);
      downloadBlob(
        csvBlob(
          ["商品コード", "在庫数", "在庫金額"],
          items.map((item) => [item.c, item.q, Math.round(Number(item.v))]),
        ),
        `在庫金額_${date}.csv`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "ダウンロードに失敗しました。");
    } finally {
      setBusy(null);
    }
  }

  if (snapshots.length === 0) {
    return <p className="empty">まだ記録がありません。「NEと照合」を押すか、毎日 03:20 の自動照合で、その日の在庫金額が保存されます。</p>;
  }

  return (
    <div className="view">
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="表示">
          <button type="button" className={!monthEndOnly ? "is-active" : ""} onClick={() => setMonthEndOnly(false)}>
            毎日
          </button>
          <button type="button" className={monthEndOnly ? "is-active" : ""} onClick={() => setMonthEndOnly(true)}>
            月ごとの最終日
          </button>
        </div>
        <span className="toolbar-note">1日1件。同じ日に何度照合しても最後の結果で上書きされます。</span>
      </div>
      {error && <p className="detail-error">{error}</p>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>日付</th>
              <th>記録時刻</th>
              <th>照合</th>
              <th className="num">在庫金額</th>
              <th className="num">在庫数</th>
              <th className="num">商品数</th>
              <th className="num">要確認</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.snapshotDate}>
                <td className="code">{dateOnly(row.snapshotDate)}</td>
                <td className="muted">{dateTime(row.takenAt)}</td>
                <td>{row.source === "cron" ? "自動" : "手動"}</td>
                <td className="num strong">{yen(row.totalValueJpy)}</td>
                <td className="num">{count(row.totalQty)}</td>
                <td className="num">{count(row.productCount)}</td>
                <td className="num">{row.needsReviewCount > 0 ? count(row.needsReviewCount) : ""}</td>
                <td className="num">
                  <button type="button" className="link" onClick={() => download(row.snapshotDate)} disabled={busy !== null}>
                    {busy === row.snapshotDate ? "作成中…" : "商品別CSV"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 照合ログ                                                             */
/* ------------------------------------------------------------------ */

export function LogsView({ logs }: { logs: LogRow[] }) {
  const [query, setQuery] = useState("");
  const [changesOnly, setChangesOnly] = useState(true);
  const rows = logs.filter((row) => {
    if (changesOnly && row.consumed === 0 && row.adjusted === 0 && row.opening === 0 && row.added === 0) return false;
    return !query.trim() || row.productCode.toLowerCase().includes(query.trim().toLowerCase());
  });

  if (logs.length === 0) return <p className="empty">まだ照合の記録がありません。</p>;

  return (
    <div className="view">
      <div className="toolbar">
        <input className="search" type="search" placeholder="商品コードで絞り込み" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={changesOnly} onChange={(e) => setChangesOnly(e.target.checked)} />
          変化があったものだけ
        </label>
        <span className="toolbar-note">最新500件</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>日時</th>
              <th>商品コード</th>
              <th>きっかけ</th>
              <th className="num">NE在庫</th>
              <th className="num">照合前の残り</th>
              <th className="num">古い便から消費</th>
              <th className="num">在庫増の調整</th>
              <th className="num">期首在庫</th>
              <th className="num">入庫</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="muted">{dateTime(row.loggedAt)}</td>
                <td className="code">{row.productCode}</td>
                <td>{row.event === "receipt" ? `入庫 ${shipmentLabel(row.shipmentId)}` : "照合"}</td>
                <td className="num">{count(row.neStock)}</td>
                <td className="num">{count(row.lotsQtyBefore)}</td>
                <td className="num">{row.consumed ? count(row.consumed) : ""}</td>
                <td className="num">{row.adjusted ? count(row.adjusted) : ""}</td>
                <td className="num">{row.opening ? count(row.opening) : ""}</td>
                <td className="num">{row.added ? count(row.added) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
