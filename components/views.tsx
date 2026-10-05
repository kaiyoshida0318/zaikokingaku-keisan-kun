"use client";

import { Fragment, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Modal from "./Modal";
import {
  fetchLots,
  fetchSnapshotItems,
  MULTI_STORE,
  sortStores,
  UNSET_STORE,
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
  rakumartDeliveryUrl,
  shipmentLabel,
  todayJst,
  unitCsv,
  unitYen,
  yen,
} from "@/lib/format";

/* ------------------------------------------------------------------ */
/* 推移グラフ                                                           */
/* ------------------------------------------------------------------ */

export function TrendChart({ snapshots, tall = false }: { snapshots: SnapshotRow[]; tall?: boolean }) {
  const points = useMemo(
    () => [...snapshots].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate)).slice(-120),
    [snapshots],
  );
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <div className="panel trend">
        <div className="panel-head"><h2>📈 在庫金額の推移</h2></div>
        <p className="panel-empty">照合が2日分以上たまると表示されます（毎日 03:20 に自動で照合します）。</p>
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
    <div className={`panel trend ${tall ? "trend--tall" : ""}`}>
      <div className="panel-head">
        <h2>📈 在庫金額の推移</h2>
        <span className="panel-head-value">
          {dateOnly(active.snapshotDate)}　<b>{yen(active.totalValueJpy)}</b>
        </span>
      </div>
      <div className="trend-body">
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
    </div>
  );
}

/** 在庫の推移タブ */
export function TrendView({ snapshots, top }: { snapshots: SnapshotRow[]; top: ReactNode }) {
  return (
    <main className="content">
      {top}
      <TrendChart snapshots={snapshots} tall />
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* 商品別                                                               */
/* ------------------------------------------------------------------ */

type ProductFilter = "stock" | "all" | "review";
type ProductSortKey = "code" | "name" | "store" | "qty" | "value" | "avg" | "latest" | "status";
type SortDir = "asc" | "desc";

// 列の並び・初期の幅。見出しをクリックで並び替え（数値の列は最初は大きい順、文字の列は昇順から）、
// 見出しの右端をドラッグで幅を変えられる。最後の列（状態）は残りの幅を使う。
const productColumns: { key: ProductSortKey; label: string; num?: boolean; firstDir: SortDir; width: number }[] = [
  { key: "code", label: "商品コード", firstDir: "asc", width: 210 },
  { key: "name", label: "商品名", firstDir: "asc", width: 260 },
  { key: "value", label: "在庫金額", num: true, firstDir: "desc", width: 130 },
  { key: "latest", label: "最新の便の原価", num: true, firstDir: "desc", width: 130 },
  { key: "avg", label: "平均原価", num: true, firstDir: "desc", width: 110 },
  { key: "qty", label: "在庫数", num: true, firstDir: "desc", width: 100 },
  { key: "store", label: "店舗", firstDir: "asc", width: 130 },
  { key: "status", label: "状態", firstDir: "desc", width: 90 },
];

const MIN_COL_WIDTH = 60;

/**
 * 列幅をドラッグで変えるためのフック。幅はこのブラウザに保存する。
 * 返す startResize を見出しのつまみの onPointerDown に、reset をダブルクリックに渡す。
 */
function useColumnWidths<K extends string>(storageKey: string, defaults: Record<K, number>) {
  const [widths, setWidths] = useState<Record<K, number>>(defaults);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as Partial<Record<K, number>> | null;
      if (saved) {
        const merged = { ...defaults };
        for (const key of Object.keys(defaults) as K[]) {
          const w = saved[key];
          if (typeof w === "number" && Number.isFinite(w)) merged[key] = Math.max(MIN_COL_WIDTH, Math.round(w));
        }
        setWidths(merged);
      }
    } catch {
      // 読めなければ初期の幅のまま
    }
    // 初回だけ読む
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  function save(next: Record<K, number>) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // 保存できなくても、この画面の間は使える
    }
  }

  function startResize(key: K, event: React.PointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = widths[key];
    let latest = widths;
    document.body.classList.add("is-col-resizing");
    const onMove = (e: PointerEvent) => {
      latest = { ...latest, [key]: Math.max(MIN_COL_WIDTH, Math.round(startWidth + e.clientX - startX)) };
      setWidths(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-col-resizing");
      save(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function reset(key: K) {
    const next = { ...widths, [key]: defaults[key] };
    setWidths(next);
    save(next);
  }

  return { widths, startResize, reset };
}

// 文字の中の数字は数の大きさで並べる（商品2 → 商品10）
const textCollator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

function compareProducts(a: ProductRow, b: ProductRow, key: ProductSortKey): number {
  // 原価が空（null）の行は、昇順・降順どちらでも最後に回す（呼び出し側で処理）
  switch (key) {
    case "code": return textCollator.compare(a.productCodeLc, b.productCodeLc);
    case "name": return textCollator.compare(a.productName, b.productName);
    case "store": return textCollator.compare(a.store, b.store);
    case "qty": return a.qty - b.qty;
    case "value": return a.valueJpy - b.valueJpy;
    case "avg": return (a.avgUnitCost ?? 0) - (b.avgUnitCost ?? 0);
    case "latest": return (a.latestUnitCost ?? 0) - (b.latestUnitCost ?? 0);
    case "status": return Number(a.needsReview) - Number(b.needsReview);
  }
}

function nullLast(a: ProductRow, b: ProductRow, key: ProductSortKey): number {
  const pick = (row: ProductRow) => (key === "avg" ? row.avgUnitCost : key === "latest" ? row.latestUnitCost : 0);
  return Number(pick(a) === null) - Number(pick(b) === null);
}

/** 店舗バッジの色：上位2店舗はオレンジ・青、それ以外は緑、「複数」は黄、「未設定」はグレー */
export function storeTone(store: string, order: string[]): string {
  if (store === UNSET_STORE) return "unset";
  if (store === MULTI_STORE) return "multi";
  const i = order.indexOf(store);
  return i === 0 ? "s0" : i === 1 ? "s1" : "s2";
}

export function StoreBadge({ store, order }: { store: string; order: string[] }) {
  return <span className={`store-badge store-badge--${storeTone(store, order)}`}>{store}</span>;
}

const IMAGE_COL_WIDTH = 64;

/** 商品画像（商品DBと同じ画像）。ないときは空の枠。押すと大きく表示 */
function ProductThumb({ row, onPreview }: { row: ProductRow; onPreview: (row: ProductRow) => void }) {
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  // 画面の準備より先に読み込みに失敗すると onError が呼ばれないので、表示後にも確かめる
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, [row.imageUrl]);
  if (!row.imageUrl || failed) return <span className="thumb thumb--empty" aria-label="画像なし" />;
  return (
    <button
      type="button"
      className="thumb"
      title="画像を大きく表示"
      onClick={(event) => {
        event.stopPropagation();
        onPreview(row);
      }}
    >
      <img ref={imgRef} src={row.imageUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
    </button>
  );
}

export function ProductsView({ products, top }: { products: ProductRow[]; top: ReactNode }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProductFilter>("stock");
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProductRow | null>(null);
  const columnWidths = useColumnWidths(
    "zaiko_product_col_widths",
    Object.fromEntries(productColumns.map((col) => [col.key, col.width])) as Record<ProductSortKey, number>,
  );
  // 最後の列（状態）以外の幅の合計。画面より広くなったら横にスクロールする
  const fixedWidth =
    IMAGE_COL_WIDTH + productColumns.slice(0, -1).reduce((sum, col) => sum + columnWidths.widths[col.key], 0);
  const [sort, setSort] = useState<{ key: ProductSortKey; dir: SortDir }>({ key: "value", dir: "desc" });

  function toggleSort(key: ProductSortKey) {
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : { key, dir: productColumns.find((col) => col.key === key)?.firstDir ?? "asc" },
    );
  }
  const [expanded, setExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(200);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = products.filter((row) => {
      if (filter === "stock" && row.qty <= 0) return false;
      if (filter === "review" && !row.needsReview) return false;
      if (storeFilter !== null && row.store !== storeFilter) return false;
      if (!q) return true;
      return row.productCodeLc.includes(q) || row.productName.toLowerCase().includes(q);
    });
    const sign = sort.dir === "asc" ? 1 : -1;
    return filtered.sort(
      (a, b) =>
        nullLast(a, b, sort.key) ||
        sign * compareProducts(a, b, sort.key) ||
        a.productCodeLc.localeCompare(b.productCodeLc),
    );
  }, [products, query, filter, storeFilter, sort]);

  // 店舗の並び順（在庫金額の大きい順。「複数」「未設定」は最後）
  const storeOrder = useMemo(() => {
    const value = new Map<string, number>();
    for (const row of products) value.set(row.store, (value.get(row.store) ?? 0) + row.valueJpy);
    return sortStores(value.keys(), (store) => value.get(store) ?? 0);
  }, [products]);

  const totalValue = rows.reduce((sum, row) => sum + row.valueJpy, 0);
  const totalQty = rows.reduce((sum, row) => sum + row.qty, 0);
  const reviewCount = products.filter((row) => row.needsReview).length;

  function exportCsv() {
    downloadBlob(
      csvBlob(
        ["商品コード", "商品名", "店舗", "商品分類タグ", "在庫数", "在庫金額", "平均原価", "最新の便の原価", "残っている便の数", "要確認"],
        rows.map((row) => [
          row.productCode,
          row.productName,
          row.store,
          row.goodsTag ?? "",
          row.qty,
          Math.round(row.valueJpy),
          unitCsv(row.avgUnitCost),
          unitCsv(row.latestUnitCost),
          row.openLots,
          row.needsReview ? "要確認" : "",
        ]),
      ),
      `在庫金額_商品別${storeFilter ? `_${storeFilter}` : ""}_${todayJst()}.csv`,
    );
  }

  return (
    <>
      <main className="content">
        {top}
        <div className="panel">
          <div className="panel-toolbar">
            <h2>📋 商品一覧</h2>
            <div className="search-box">
              <span>⌕</span>
              <input
                type="search"
                placeholder="商品コード・商品名で検索..."
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(200);
                }}
              />
            </div>
            <div className="seg" role="group" aria-label="絞り込み">
              {(
                [
                  ["stock", "在庫あり", products.filter((row) => row.qty > 0).length],
                  ["all", "すべて", products.length],
                  ["review", "要確認", reviewCount],
                ] as const
              ).map(([key, label, n]) => (
                <button key={key} type="button" className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>
                  {label}
                  <span className="seg-cnt">{n}</span>
                </button>
              ))}
            </div>
            {storeOrder.length > 1 || storeOrder[0] !== UNSET_STORE ? (
              <label className="store-select">
                <span>店舗</span>
                <select
                  value={storeFilter ?? ""}
                  onChange={(event) => {
                    setStoreFilter(event.target.value || null);
                    setLimit(200);
                  }}
                >
                  <option value="">すべての店舗</option>
                  {storeOrder.map((store) => (
                    <option key={store} value={store}>
                      {store}（{count(products.filter((row) => row.store === store && (filter !== "stock" || row.qty > 0)).length)}）
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="toolbar-spacer" />
            <span className="result-count">
              {count(rows.length)}商品・{count(totalQty)}個・{yen(totalValue)}
            </span>
            <button
              type="button"
              className="btn-add"
              onClick={exportCsv}
              disabled={rows.length === 0}
              title="商品一覧で絞り込み・並び替えした内容のまま出力します"
            >
              ⤓ CSV出力
            </button>
          </div>
          {rows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📭</div>
              <div className="empty-title">{products.length === 0 ? "まだ便ごとの在庫がありません" : "条件に合う商品がありません"}</div>
              {products.length === 0 && (
                <div className="empty-desc">
                  入庫一括でNE更新すると登録されます。今ある在庫をまとめて登録するには「🔄 照合と更新」で「便のない商品も導入前在庫として登録」を選んで照合してください。
                </div>
              )}
            </div>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl tbl--resizable" style={{ minWidth: fixedWidth + MIN_COL_WIDTH + 30 }}>
                <colgroup>
                  <col style={{ width: IMAGE_COL_WIDTH }} />
                  {productColumns.map((col, i) => (
                    <col
                      key={col.key}
                      style={i === productColumns.length - 1 ? undefined : { width: columnWidths.widths[col.key] }}
                    />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <th className="thumb-cell" aria-label="画像" />
                    {productColumns.map((col, i) => {
                      const active = sort.key === col.key;
                      const isLast = i === productColumns.length - 1;
                      return (
                        <th
                          key={col.key}
                          className={col.num ? "num" : undefined}
                          aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                        >
                          <button
                            type="button"
                            className={`th-sort ${active ? "is-active" : ""}`}
                            onClick={() => toggleSort(col.key)}
                            title={`${col.label}で並び替え`}
                          >
                            {col.label}
                            <span className="th-sort-icon" aria-hidden="true">
                              {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                            </span>
                          </button>
                          {!isLast && (
                            <span
                              className="col-resizer"
                              role="separator"
                              aria-orientation="vertical"
                              aria-label={`${col.label}の幅`}
                              title="ドラッグで幅を変更（ダブルクリックで元の幅）"
                              onPointerDown={(event) => columnWidths.startResize(col.key, event)}
                              onClick={(event) => event.stopPropagation()}
                              onDoubleClick={() => columnWidths.reset(col.key)}
                            />
                          )}
                        </th>
                      );
                    })}
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
                          <td className="thumb-cell">
                            <ProductThumb row={row} onPreview={setPreview} />
                          </td>
                          {productColumns.map((col) => {
                            switch (col.key) {
                              case "code":
                                return (
                                  <td key={col.key} className="code" title={row.productCode}>
                                    <span className="chevron" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                                    {row.productCode}
                                  </td>
                                );
                              case "name":
                                return <td key={col.key} className="name" title={row.productName}>{row.productName}</td>;
                              case "value":
                                return <td key={col.key} className="num strong">{yen(row.valueJpy)}</td>;
                              case "latest":
                                return <td key={col.key} className="num">{unitYen(row.latestUnitCost)}</td>;
                              case "avg":
                                return <td key={col.key} className="num">{unitYen(row.avgUnitCost)}</td>;
                              case "qty":
                                return <td key={col.key} className="num">{count(row.qty)}</td>;
                              case "store":
                                return (
                                  <td key={col.key} title={row.goodsTag ?? "商品分類タグなし"}>
                                    <StoreBadge store={row.store} order={storeOrder} />
                                  </td>
                                );
                              case "status":
                                return (
                                  <td key={col.key}>
                                    {row.needsReview ? <span className="status warn">要確認</span> : <span className="status success">OK</span>}
                                  </td>
                                );
                            }
                          })}
                        </tr>
                        {isOpen && (
                          <tr className="detail-row">
                            <td colSpan={productColumns.length + 1}>
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
      </main>
      {preview && (
        <Modal title={preview.productCode} onClose={() => setPreview(null)}>
          <div className="thumb-preview">
            <img src={preview.imageUrl} alt={preview.productName || preview.productCode} />
            {preview.productName && <p>{preview.productName}</p>}
          </div>
        </Modal>
      )}
    </>
  );
}

const lotTypeLabel: Record<LotRow["lotType"], string> = {
  shipment: "入庫",
  // このアプリを使い始める前からあった在庫（NEの在庫数・原価で登録したもの）
  opening: "導入前在庫",
  adjust: "在庫増の調整",
};

function LotDetail({ productCodeLc }: { productCodeLc: string }) {
  const [lots, setLots] = useState<LotRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  return <LotTable lots={lots} />;
}

/**
 * 出荷で減る順番（SQL の cost__reconcile と同じ）：導入前在庫 → 登録日の古い順 → id の小さい順。
 * 残りのある在庫だけに 1, 2, 3… を振る。1 が「出荷中」の在庫。
 */
function consumeOrder(lots: LotRow[]): Map<number, number> {
  const live = lots
    .filter((lot) => lot.qtyRemaining > 0)
    .sort(
      (a, b) =>
        Number(a.lotType !== "opening") - Number(b.lotType !== "opening") ||
        a.receivedAt.localeCompare(b.receivedAt) ||
        a.id - b.id,
    );
  return new Map(live.map((lot, i) => [lot.id, i + 1]));
}

/** 商品を開いたときの在庫（便ごと）の一覧 */
export function LotTable({ lots }: { lots: LotRow[] }) {
  const [showUsed, setShowUsed] = useState(false);

  // 表示は新しい順。導入前在庫はいちばん古い扱い（出荷で最初に減る）なので、登録日に関係なく最後に並べる
  const ordered = [...lots].sort(
    (a, b) =>
      Number(a.lotType === "opening") - Number(b.lotType === "opening") ||
      b.receivedAt.localeCompare(a.receivedAt) ||
      b.id - a.id,
  );
  const order = consumeOrder(lots);
  const visible = showUsed ? ordered : ordered.filter((lot) => lot.qtyRemaining > 0);
  const usedCount = lots.length - order.size;
  const next = ordered.find((lot) => order.get(lot.id) === 1) ?? null;

  return (
    <div className="detail">
      <div className="detail-head">
        <span>
          新しい順。出荷は<b className="next-word">出荷中</b>の在庫から減り、なくなると1つ上の在庫に移ります。
          {next && (
            <>
              {" "}いま出荷中なのは<b>{lotName(next)}</b>（残り{count(next.qtyRemaining)}個・1個 {unitYen(next.unitCost)}）。
            </>
          )}
        </span>
        {usedCount > 0 && (
          <button type="button" className="text-btn" onClick={() => setShowUsed((v) => !v)}>
            {showUsed ? "出荷済みの在庫を隠す" : `出荷済みの在庫も表示（${usedCount}）`}
          </button>
        )}
      </div>
      <table className="tbl tbl--inner">
        <thead>
          <tr>
            <th rowSpan={2}>出荷状況</th>
            <th rowSpan={2} className="num">入庫数</th>
            <th rowSpan={2} className="num">残り</th>
            <th rowSpan={2} className="num">残り金額</th>
            <th colSpan={5} className="cost-group-head">1単位原価 ＝ 商品 ＋ オプション ＋ 国内運賃 ＋ 国際送料</th>
            <th rowSpan={2}>種類</th>
            <th rowSpan={2}>便</th>
            <th rowSpan={2}>登録日</th>
            <th rowSpan={2}>メモ</th>
          </tr>
          <tr>
            <th className="num cost-col cost-col--first">1単位原価</th>
            <th className="num cost-col"><span className="cost-op">＝</span>商品</th>
            <th className="num cost-col"><span className="cost-op">＋</span>オプション</th>
            <th className="num cost-col"><span className="cost-op">＋</span>国内運賃</th>
            <th className="num cost-col cost-col--last"><span className="cost-op">＋</span>国際送料</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((lot) => {
            const rank = order.get(lot.id);
            const ratio = lot.qtyIn > 0 ? lot.qtyRemaining / lot.qtyIn : 0;
            return (
              <tr key={lot.id} className={rank === undefined ? "is-used" : rank === 1 ? "is-next" : ""}>
                <td>
                  {/* 出荷中より新しい在庫（2番目以降）は空欄 */}
                  {rank === undefined ? (
                    <span className="consume consume--used">出荷済み</span>
                  ) : rank === 1 ? (
                    <span className="consume consume--next">▶ 出荷中</span>
                  ) : null}
                </td>
                <td className="num">{count(lot.qtyIn)}</td>
                <td className="num strong">
                  <span className="meter" aria-hidden="true" title={`入庫数の${Math.round(ratio * 100)}%が残っています`}>
                    <span style={{ width: `${Math.round(ratio * 100)}%` }} />
                  </span>
                  {count(lot.qtyRemaining)}
                </td>
                <td className="num">{yen(lot.qtyRemaining * (lot.unitCost ?? 0))}</td>
                <td className="num strong cost-col cost-col--first">{unitYen(lot.unitCost)}</td>
                {hasBreakdown(lot) ? (
                  <>
                    <td className="num cost-col"><span className="cost-op">＝</span>{unitYen(lot.unitGoods ?? 0)}</td>
                    <td className="num cost-col"><span className="cost-op">＋</span>{unitYen(lot.unitOption ?? 0)}</td>
                    <td className="num cost-col"><span className="cost-op">＋</span>{unitYen(lot.unitDomestic ?? 0)}</td>
                    <td className="num cost-col cost-col--last">
                      <span className="cost-op">＋</span>
                      {unitYen((lot.unitIntl ?? 0) + (lot.unitOther ?? 0))}
                    </td>
                  </>
                ) : (
                  <td colSpan={4} className="cost-col cost-col--last cost-none">
                    {lot.lotType === "opening" ? "内訳なし（NEの原価）" : "内訳なし"}
                  </td>
                )}
                <td>
                  {lotTypeLabel[lot.lotType]}
                  {lot.needsReview && <span className="status warn">要確認</span>}
                </td>
                <td>{lot.lotType === "shipment" ? <ShipmentCell id={lot.shipmentId} /> : "—"}</td>
                <td>
                  {lot.lotType === "opening" ? (
                    <span title="このアプリを使い始める前からあった在庫です">
                      導入前
                      {lot.createdAt && <small className="lot-sub">{dateOnly(lot.createdAt)} にNEから取得</small>}
                    </span>
                  ) : (
                    dateOnly(lot.receivedAt)
                  )}
                </td>
                <td className="note">
                  {lot.note ?? ""}
                  {lot.preAppCost !== null && (
                    <span className="pre-app-cost" title="アプリ導入前のNEの原価（バックアップから）。在庫金額の計算には使っていません">
                      導入前のNE原価 {unitYen(lot.preAppCost)}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 配送依頼書番号（押すとラクマートの配送詳細を新しいタブで開く） */
function ShipmentLink({ id }: { id: string | null }) {
  const url = rakumartDeliveryUrl(id);
  if (!id || !url) return <>—</>;
  return (
    <a
      className="shipment-link"
      href={url}
      target="_blank"
      rel="noreferrer"
      title="ラクマートの配送詳細を開く"
      onClick={(event) => event.stopPropagation()}
    >
      {id}
    </a>
  );
}

/** 「09/18 08:54便」＋その下に配送依頼書番号のリンク */
function ShipmentCell({ id }: { id: string | null }) {
  return (
    <span className="shipment-cell">
      {shipmentLabel(id)}
      {id && <ShipmentLink id={id} />}
    </span>
  );
}

/** 原価の内訳（商品・オプション・国内運賃・国際送料）があるか。導入前在庫・調整は内訳がないことが多い */
function hasBreakdown(lot: LotRow): boolean {
  return [lot.unitGoods, lot.unitOption, lot.unitDomestic, lot.unitIntl, lot.unitOther].some((v) => v !== null);
}

/** 「09/15 21:47便」「導入前在庫」など、在庫の呼び名 */
function lotName(lot: LotRow): string {
  return lot.lotType === "shipment" ? shipmentLabel(lot.shipmentId) : lotTypeLabel[lot.lotType];
}

/* ------------------------------------------------------------------ */
/* 便別                                                                 */
/* ------------------------------------------------------------------ */

export function ShipmentsView({ shipments, top }: { shipments: ShipmentRow[]; top: ReactNode }) {
  const remaining = shipments.reduce((sum, row) => sum + row.valueRemainingJpy, 0);
  return (
    <>
      <main className="content">
        {top}
        <div className="panel">
          <div className="panel-toolbar">
            <h2>🚚 便別（配送依頼書ごと）</h2>
            <div className="toolbar-spacer" />
            <span className="result-count">{count(shipments.length)}便・残り {yen(remaining)}</span>
          </div>
      {shipments.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🚚</div>
          <div className="empty-title">まだ便が登録されていません</div>
          <div className="empty-desc">入庫一括でNE更新すると、配送依頼書ごとに登録されます。</div>
        </div>
      ) : (
      <div className="tbl-wrap">
        <table className="tbl">
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
                  <td className="muted"><ShipmentLink id={row.shipmentId} /></td>
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
                  <td className="statuses">
                    {row.unallocatedJpy > 0.5 && <span className="status error">未割当 {yen(row.unallocatedJpy)}</span>}
                    {row.needsReview && <span className="status warn">要確認</span>}
                    {row.qtyIn > 0 && row.qtyRemaining === 0 ? <span className="status paused">使い切り</span> : <span className="status monitoring">在庫あり</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
        </div>
      </main>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* スナップショット                                                     */
/* ------------------------------------------------------------------ */

export function SnapshotsView({ snapshots, top }: { snapshots: SnapshotRow[]; top: ReactNode }) {
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

  // 記録に出てくる店舗（店舗に対応する前の記録には内訳がない）
  const stores = useMemo(() => {
    const value = new Map<string, number>();
    for (const row of snapshots) {
      for (const [store, t] of Object.entries(row.byStore)) value.set(store, (value.get(store) ?? 0) + t.v);
    }
    return sortStores(value.keys(), (store) => value.get(store) ?? 0);
  }, [snapshots]);

  function exportList() {
    downloadBlob(
      csvBlob(
        ["日付", "照合", "在庫金額", ...stores.map((store) => `${store}（金額）`), "在庫数", ...stores.map((store) => `${store}（個数）`), "商品数", "要確認"],
        rows.map((row) => [
          row.snapshotDate,
          row.source === "cron" ? "自動" : "手動",
          Math.round(row.totalValueJpy),
          ...stores.map((store) => (row.byStore[store] ? Math.round(row.byStore[store].v) : "")),
          row.totalQty,
          ...stores.map((store) => row.byStore[store]?.q ?? ""),
          row.productCount,
          row.needsReviewCount,
        ]),
      ),
      `在庫金額_${monthEndOnly ? "月末" : "日ごと"}_${todayJst()}.csv`,
    );
  }

  async function download(date: string) {
    setBusy(date);
    setError(null);
    try {
      const items = await fetchSnapshotItems(date);
      downloadBlob(
        csvBlob(
          ["商品コード", "店舗", "在庫数", "在庫金額"],
          items.map((item) => [item.c, item.s ?? "", item.q, Math.round(Number(item.v))]),
        ),
        `在庫金額_${date}.csv`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "ダウンロードに失敗しました。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <main className="content">
        {top}
        {error && <p className="form-error">{error}</p>}
        <div className="panel">
          <div className="panel-toolbar">
            <h2>📅 日ごとの記録</h2>
            <div className="seg" role="group" aria-label="表示">
              <button type="button" className={!monthEndOnly ? "active" : ""} onClick={() => setMonthEndOnly(false)}>
                毎日
              </button>
              <button type="button" className={monthEndOnly ? "active" : ""} onClick={() => setMonthEndOnly(true)}>
                月ごとの最終日
              </button>
            </div>
            <p className="toolbar-note">1日1件。同じ日に何度照合しても最後の結果で上書きされます。</p>
            <div className="toolbar-spacer" />
            <span className="result-count">{count(rows.length)}件</span>
            <button type="button" className="btn-secondary" onClick={exportList} disabled={rows.length === 0}>
              ⤓ 一覧CSV
            </button>
          </div>
      {snapshots.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📅</div>
          <div className="empty-title">まだ記録がありません</div>
          <div className="empty-desc">「🔄 照合と更新」で照合するか、毎日 03:20 の自動照合で、その日の在庫金額が保存されます。</div>
        </div>
      ) : (
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>日付</th>
              <th>記録時刻</th>
              <th>照合</th>
              <th className="num">在庫金額</th>
              {stores.map((store) => (
                <th key={store} className="num">{store}</th>
              ))}
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
                <td>{row.source === "cron" ? <span className="status success">自動</span> : <span className="status monitoring">手動</span>}</td>
                <td className="num strong">{yen(row.totalValueJpy)}</td>
                {stores.map((store) => {
                  const t = row.byStore[store];
                  return (
                    <td key={store} className="num" title={t ? `${count(t.q)}個・${count(t.n)}商品` : "この日は店舗別の内訳がありません"}>
                      {t ? yen(t.v) : <span className="muted">—</span>}
                    </td>
                  );
                })}
                <td className="num">{count(row.totalQty)}</td>
                <td className="num">{count(row.productCount)}</td>
                <td className="num">{row.needsReviewCount > 0 ? count(row.needsReviewCount) : ""}</td>
                <td className="num">
                  <button type="button" className="text-btn" onClick={() => download(row.snapshotDate)} disabled={busy !== null}>
                    {busy === row.snapshotDate ? "作成中…" : "商品別CSV"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
        </div>
      </main>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 照合ログ                                                             */
/* ------------------------------------------------------------------ */

export function LogsView({ logs, top }: { logs: LogRow[]; top: ReactNode }) {
  const [query, setQuery] = useState("");
  const [changesOnly, setChangesOnly] = useState(true);
  const rows = logs.filter((row) => {
    if (changesOnly && row.consumed === 0 && row.adjusted === 0 && row.opening === 0 && row.added === 0) return false;
    return !query.trim() || row.productCode.toLowerCase().includes(query.trim().toLowerCase());
  });

  return (
    <>
      <main className="content">
        {top}
        <div className="panel">
          <div className="panel-toolbar">
            <h2>🕒 照合ログ</h2>
            <div className="search-box">
              <span>⌕</span>
              <input type="search" placeholder="商品コードで絞り込み..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <label className="check">
              <input type="checkbox" checked={changesOnly} onChange={(e) => setChangesOnly(e.target.checked)} />
              変化があったものだけ
            </label>
            <div className="toolbar-spacer" />
            <span className="result-count">{count(rows.length)}件（最新500件から）</span>
          </div>
      {rows.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🕒</div>
          <div className="empty-title">{logs.length === 0 ? "まだ照合の記録がありません" : "条件に合う記録がありません"}</div>
        </div>
      ) : (
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>日時</th>
              <th>商品コード</th>
              <th>きっかけ</th>
              <th className="num">NE在庫</th>
              <th className="num">照合前の残り</th>
              <th className="num">古い便から消費</th>
              <th className="num">在庫増の調整</th>
              <th className="num">導入前在庫</th>
              <th className="num">入庫</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="muted">{dateTime(row.loggedAt)}</td>
                <td className="code">{row.productCode}</td>
                <td>{row.event === "receipt" ? (
                  <span className="status monitoring">入庫 {shipmentLabel(row.shipmentId)}</span>
                ) : row.event === "backfill" ? (
                  <span className="status warn">過去の便 {shipmentLabel(row.shipmentId)}</span>
                ) : (
                  <span className="status paused">照合</span>
                )}</td>
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
      )}
        </div>
      </main>
    </>
  );
}
