"use client";

import { Fragment, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Modal from "./Modal";
import PeriodBar, { inPeriod, periodLabel, resolvePeriod, type Period } from "./PeriodBar";
import {
  fetchLots,
  fetchSnapshotItems,
  MULTI_STORE,
  sortStores,
  UNSET_STORE,
  type LogRow,
  type LotRow,
  type OldCostData,
  type ProductRow,
  type ShipmentRow,
  type SnapshotRow,
} from "@/lib/data";
import {
  cny,
  count,
  csvBlob,
  dateOnly,
  dateTime,
  downloadBlob,
  rakumartDeliveryUrl,
  costSign,
  rateText,
  shipmentLabel,
  timeOnly,
  todayJst,
  unitCsv,
  unitYen,
  yen,
} from "@/lib/format";

/* ------------------------------------------------------------------ */
/* 在庫推移(グラフ)                                                    */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/** yyyy-mm-dd → その日0時（UTC）のミリ秒。日付だけを扱うので時差は気にしない */
function dayMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** 縦軸の目盛り：だいたい count 本になる、きりのいい間隔（1・2・2.5・5 × 10^n） */
function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) {
    const pad = Math.max(Math.abs(max) * 0.05, 1);
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/** 縦軸のラベル：1万円以上の間隔なら「1,920万」、それ未満は円のまま */
function axisYen(value: number, step: number): string {
  if (step >= 10_000) {
    const man = value / 10_000;
    return `${man.toLocaleString("ja-JP", { maximumFractionDigits: step >= 100_000 ? 0 : 1 })}万`;
  }
  return value.toLocaleString("ja-JP");
}

/** 横軸の目盛り：期間に合わせて 1日 / 2日 / 1週 / 2週 / 月初 */
function dateTicks(t0: number, t1: number): number[] {
  const spanDays = Math.round((t1 - t0) / DAY_MS);
  if (spanDays > 100) {
    const ticks: number[] = [];
    const d = new Date(t0);
    let y = d.getUTCFullYear();
    let m = d.getUTCMonth() + (d.getUTCDate() === 1 ? 0 : 1);
    const every = spanDays > 400 ? 3 : spanDays > 200 ? 2 : 1;
    for (;;) {
      const t = Date.UTC(y + Math.floor(m / 12), m % 12, 1);
      if (t > t1) break;
      if ((m % 12) % every === 0) ticks.push(t);
      m += 1;
    }
    return ticks;
  }
  const step = [1, 2, 7, 14].find((s) => spanDays / s <= 8) ?? 14;
  const ticks: number[] = [];
  for (let t = t1; t >= t0; t -= step * DAY_MS) ticks.unshift(t); // 最新の日を必ず目盛りに含める
  return ticks;
}

function dateTickLabel(t: number, monthly: boolean, withYear: boolean): string {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (monthly) return withYear ? `${y}/${String(m).padStart(2, "0")}` : `${m}月`;
  return `${m}/${d.getUTCDate()}`;
}

/** 前の点（記録）との比較：増減（金額）と、その間の入庫・出荷 */
type SnapshotChange = {
  diff: number; // 在庫金額の増減
  inValue: number; // 入庫（入庫一括＋在庫増の調整）
  received: number;
  adjusted: number;
  opening: number; // 旧原価在庫の登録
  outValue: number; // 出荷（先入先出の原価）
  other: number; // 増減のうち、入庫・出荷・旧原価在庫で説明できない分（原価の置き換えなど）
  complete: boolean; // 金額を記録する前のログが混じっていない
};

/** 月別：各月の最後の記録（月末時点。今月はいちばん新しい記録）。古い順 */
function monthEndSeries(snapshots: SnapshotRow[]): SnapshotRow[] {
  const byMonth = new Map<string, SnapshotRow>();
  for (const row of [...snapshots].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate))) {
    byMonth.set(row.snapshotDate.slice(0, 7), row);
  }
  return [...byMonth.values()];
}

/**
 * series の各点について、1つ前の点との比較を出す（キーは snapshotDate）。
 * 入庫・出荷は、2つの点の間にあるすべての記録の出入りを合計する（月別でも日ごとの出入りを足し上げる）。
 */
function snapshotChanges(snapshots: SnapshotRow[], series: SnapshotRow[]): Map<string, SnapshotChange> {
  const allAsc = [...snapshots].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
  const seriesAsc = [...series].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
  const map = new Map<string, SnapshotChange>();
  seriesAsc.forEach((row, i) => {
    const prev = seriesAsc[i - 1];
    if (!prev) return;
    let received = 0;
    let adjusted = 0;
    let opening = 0;
    let outValue = 0;
    let complete = true;
    for (const s of allAsc) {
      if (s.snapshotDate <= prev.snapshotDate || s.snapshotDate > row.snapshotDate) continue;
      if (!s.movement) {
        complete = false;
        continue;
      }
      received += s.movement.receivedValue;
      adjusted += s.movement.adjustedValue;
      opening += s.movement.openingValue;
      outValue += s.movement.shippedValue;
      if (!s.movement.complete) complete = false;
    }
    const diff = row.totalValueJpy - prev.totalValueJpy;
    const inValue = received + adjusted;
    map.set(row.snapshotDate, {
      diff,
      inValue,
      received,
      adjusted,
      opening,
      outValue,
      other: diff - (inValue - outValue + opening),
      complete,
    });
  });
  return map;
}

function signedYen(value: number): string {
  const r = Math.round(value);
  return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${yen(Math.abs(value))}`;
}

export function TrendChart({
  snapshots,
  period,
  onPeriodChange,
  tall = false,
}: {
  snapshots: SnapshotRow[];
  period: Period;
  onPeriodChange: (next: Period) => void;
  tall?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // 幅を測る枠（グラフがない表示のときも残る外枠で測る。中だけで測ると、グラフが消えて戻ったときに幅を見失う）
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const monthly = period.mode === "monthly";
  const firstDate = useMemo(
    () => snapshots.reduce<string | null>((min, row) => (min === null || row.snapshotDate < min ? row.snapshotDate : min), null),
    [snapshots],
  );
  const range = resolvePeriod(period, firstDate);

  // 実際の幅で描く（引き伸ばすと文字や線がゆがむため）
  useEffect(() => {
    if (!box) return;
    const update = () => {
      if (box.clientWidth > 0) setWidth(Math.max(320, box.clientWidth));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);

  // 日別はすべての記録、月別は各月の最後の記録（古い順）
  const series = useMemo(
    () => (monthly ? monthEndSeries(snapshots) : [...snapshots].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate))),
    [snapshots, monthly],
  );
  // 前の点からの増減と内訳（期間で切っても、いちばん左の点は1つ前の点と比べる）
  const changes = useMemo(() => snapshotChanges(snapshots, series), [snapshots, series]);
  // 選んでいる期間の点（表と同じ期間）
  const points = useMemo(
    () => series.filter((p) => inPeriod(p.snapshotDate, period.mode, range)),
    [series, period.mode, range.from, range.to],
  );

  // 吹き出しの店舗の色（商品一覧のバッジと同じ並び）
  const storeOrder = useMemo(() => {
    const value = new Map<string, number>();
    for (const row of snapshots) for (const [store, t] of Object.entries(row.byStore)) value.set(store, (value.get(store) ?? 0) + t.v);
    return sortStores(value.keys(), (store) => value.get(store) ?? 0);
  }, [snapshots]);

  function changePeriod(next: Period) {
    setHover(null);
    onPeriodChange(next);
  }

  const header = (
    <>
      <div className="panel-head trend-head">
        <h2>📈 在庫金額の推移</h2>
      </div>
      <PeriodBar period={period} onChange={changePeriod} firstDate={firstDate} />
    </>
  );

  // 点の呼び名：日別は日付、月別は「2026/10（10/07時点）」
  const pointLabel = (p: SnapshotRow) =>
    monthly ? `${p.snapshotDate.slice(0, 4)}/${p.snapshotDate.slice(5, 7)}（${p.snapshotDate.slice(5, 7)}/${p.snapshotDate.slice(8, 10)}時点）` : dateOnly(p.snapshotDate);

  if (points.length < 2) {
    const only = points[0] ?? null;
    const unit = monthly ? "か月" : "日";
    return (
      <div className={`panel trend ${tall ? "trend--tall" : ""}`} ref={setBox}>
        {header}
        <p className="panel-empty">
          {series.length < 2
            ? monthly
              ? "月別は2か月分以上の記録がたまると線になります。"
              : "照合が2日分以上たまると線になります（毎日 21:05 に自動で照合します）。"
            : `${periodLabel(range)} の記録が2${unit}分未満なので線を引けません。期間を広げてください。`}
          {only && (
            <>
              {" "}
              {pointLabel(only)}：<b>{yen(only.totalValueJpy)}</b>
            </>
          )}
        </p>
      </div>
    );
  }

  /* ---------- 寸法 ---------- */
  const lineH = tall ? 340 : 220;
  const pad = { top: 16, right: 24, bottom: 30, left: 72 };
  const innerW = width - pad.left - pad.right;
  const H = pad.top + lineH + pad.bottom;
  const axisY = pad.top + lineH;

  // 横位置：日別は日付の間隔どおり、月別は1か月ずつ等間隔（両端の点が切れないよう少し内側から）
  const t0 = dayMs(points[0].snapshotDate);
  const t1 = dayMs(points[points.length - 1].snapshotDate);
  const inset = 8;
  const plotL = pad.left + inset;
  const plotW = innerW - inset * 2;
  const xAt = (t: number) => plotL + ((t - t0) / Math.max(t1 - t0, 1)) * plotW;
  const xOf = (i: number) => (monthly ? plotL + (i / (points.length - 1)) * plotW : xAt(dayMs(points[i].snapshotDate)));

  // 縦軸
  const values = points.map((p) => p.totalValueJpy);
  const yTicks = niceTicks(Math.min(...values), Math.max(...values));
  const yMin = yTicks[0];
  const yMax = yTicks[yTicks.length - 1];
  const yStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : 1;
  const y = (v: number) => pad.top + (1 - (v - yMin) / Math.max(yMax - yMin, 1)) * lineH;

  // 横軸の目盛り
  const withYear = new Date(t0).getUTCFullYear() !== new Date(t1).getUTCFullYear();
  const xTicks: Array<{ x: number; label: string }> = monthly
    ? (() => {
        const every = Math.ceil(points.length / Math.max(2, Math.floor(innerW / 64)));
        return points
          .map((p, i) => ({ i, p }))
          .filter(({ i }) => (points.length - 1 - i) % every === 0) // 最新の月を必ず入れる
          .map(({ i, p }) => ({ x: xOf(i), label: dateTickLabel(dayMs(p.snapshotDate), true, withYear || points.length > 12) }));
      })()
    : dateTicks(t0, t1).map((t) => ({
        x: xAt(t),
        label: dateTickLabel(t, (t1 - t0) / DAY_MS > 100, withYear),
      }));

  const coords = points.map((p, i) => ({ p, cx: xOf(i), cy: y(p.totalValueJpy), c: changes.get(p.snapshotDate) ?? null }));
  const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.cx.toFixed(1)},${c.cy.toFixed(1)}`).join(" ");
  const area = `${line} L${coords[coords.length - 1].cx.toFixed(1)},${axisY} L${coords[0].cx.toFixed(1)},${axisY} Z`;
  const last = coords[coords.length - 1];
  const active = hover !== null ? coords[hover] ?? null : null;
  const showMarkers = points.length <= 40;

  function onMove(event: React.MouseEvent<SVGRectElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left + pad.left;
    let best = 0;
    for (let i = 1; i < coords.length; i += 1) {
      if (Math.abs(coords[i].cx - px) < Math.abs(coords[best].cx - px)) best = i;
    }
    setHover(best);
  }

  // 吹き出し：増減と、その間の入庫・出荷（金額がない・0円なら —）
  const tipChange = active?.c ?? null;
  const moveText = (value: number, sign: "+" | "−") =>
    tipChange?.complete && Math.round(value) !== 0 ? `${sign}${yen(value)}` : "—";
  // 吹き出しは点の左右どちらか、はみ出さない側に出す
  const tipLeft = active ? (active.cx > width * 0.6 ? active.cx - 14 : active.cx + 14) : 0;
  const tipAlign = active && active.cx > width * 0.6 ? "translateX(-100%)" : "none";
  const tipHeight = 70 + storeOrder.length * 19 + (tipChange ? 70 : 0);
  const tipTop = active ? Math.min(Math.max(8, active.cy - 20), H - tipHeight) : 0;

  return (
    <div className={`panel trend ${tall ? "trend--tall" : ""}`} ref={setBox}>
      {header}
      <div className="trend-body">
        <svg className="trend-svg" width={width} height={H} role="img" aria-label="在庫金額の推移">
          {/* 縦軸：目盛りと細い横線 */}
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line className="trend-grid" x1={pad.left} x2={pad.left + innerW} y1={y(v)} y2={y(v)} />
              <text className="trend-tick" x={pad.left - 10} y={y(v)} textAnchor="end" dominantBaseline="middle">
                {axisYen(v, yStep)}
              </text>
            </g>
          ))}
          {/* 横軸：日付の目盛り */}
          <line className="trend-axis-line" x1={pad.left} x2={pad.left + innerW} y1={axisY} y2={axisY} />
          {xTicks.map((t) => (
            <g key={`x${t.x}`}>
              <line className="trend-axis-line" x1={t.x} x2={t.x} y1={axisY} y2={axisY + 4} />
              <text className="trend-tick" x={t.x} y={axisY + 18} textAnchor={t.x > pad.left + innerW - 24 ? "end" : t.x < pad.left + 24 ? "start" : "middle"}>
                {t.label}
              </text>
            </g>
          ))}
          {/* データ */}
          <path className="trend-area" d={area} />
          <path className="trend-line" d={line} />
          {showMarkers &&
            coords.map((c) => <circle key={c.p.snapshotDate} className="trend-marker" cx={c.cx} cy={c.cy} r={3} />)}
          {!active && <circle className="trend-dot" cx={last.cx} cy={last.cy} r={4.5} />}
          {/* マウスを乗せた点 */}
          {active && (
            <g>
              <line className="trend-cursor" x1={active.cx} x2={active.cx} y1={pad.top} y2={axisY} />
              <circle className="trend-dot" cx={active.cx} cy={active.cy} r={5} />
            </g>
          )}
          <rect
            className="trend-hit"
            x={pad.left}
            y={pad.top}
            width={innerW}
            height={lineH}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          />
        </svg>
        {active && (
          <div className="trend-tip" style={{ left: tipLeft, top: Math.max(0, tipTop), transform: tipAlign }}>
            <div className="trend-tip-date">{pointLabel(active.p)}</div>
            <div className="trend-tip-total">{yen(active.p.totalValueJpy)}</div>
            {storeOrder
              .filter((store) => active.p.byStore[store])
              .map((store) => (
                <div key={store} className="trend-tip-row">
                  <span className={`store-dot tone-${storeTone(store, storeOrder)}`} aria-hidden="true" />
                  <span>{store}</span>
                  <b>{yen(active.p.byStore[store].v)}</b>
                </div>
              ))}
            {tipChange && (
              <div className="trend-tip-change">
                <div className="trend-tip-line">
                  <span>増減</span>
                  <b className={tipChange.diff > 0 ? "chg-up" : tipChange.diff < 0 ? "chg-down" : ""}>{signedYen(tipChange.diff)}</b>
                </div>
                <div className="trend-tip-line">
                  <span>入庫</span>
                  <b>{moveText(tipChange.inValue, "+")}</b>
                </div>
                <div className="trend-tip-line">
                  <span>出荷</span>
                  <b>{moveText(tipChange.outValue, "−")}</b>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="trend-foot">
        <span>
          {pointLabel(points[0])} 〜 {pointLabel(points[points.length - 1])}（{count(points.length)}{monthly ? "か月" : "日"}分）
        </span>
        <span>
          最新 <b>{yen(last.p.totalValueJpy)}</b>
          <span className="trend-diff">（期間の初めから {signedYen(last.p.totalValueJpy - points[0].totalValueJpy)}）</span>
        </span>
      </div>
    </div>
  );
}

/** 在庫推移(グラフ)タブ */
export function TrendView({
  snapshots,
  period,
  onPeriodChange,
  top,
}: {
  snapshots: SnapshotRow[];
  period: Period;
  onPeriodChange: (next: Period) => void;
  top: ReactNode;
}) {
  return (
    <main className="content">
      {top}
      <TrendChart snapshots={snapshots} period={period} onPeriodChange={onPeriodChange} tall />
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
 * 列幅をドラッグで変えるためのフック。変えた幅だけをこのブラウザに保存し、ほかの列は初期の幅。
 * 列が後から増えても（在庫推移(表)の店舗の列など）そのまま使える。
 * widthOf(key) で幅、startResize を見出しのつまみの onPointerDown に、reset をダブルクリックに渡す。
 */
function useColumnWidths(storageKey: string, defaults: Record<string, number>) {
  const [saved, setSaved] = useState<Record<string, number>>({});

  useEffect(() => {
    try {
      const raw = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as Record<string, unknown> | null;
      if (raw && typeof raw === "object") {
        const clean: Record<string, number> = {};
        for (const [key, w] of Object.entries(raw)) {
          if (typeof w === "number" && Number.isFinite(w)) clean[key] = Math.max(MIN_COL_WIDTH, Math.round(w));
        }
        setSaved(clean);
      }
    } catch {
      // 読めなければ初期の幅のまま
    }
  }, [storageKey]);

  const widthOf = (key: string) => saved[key] ?? defaults[key] ?? 120;

  function persist(next: Record<string, number>) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // 保存できなくても、この画面の間は使える
    }
  }

  function startResize(key: string, event: React.PointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = widthOf(key);
    let latest = saved;
    document.body.classList.add("is-col-resizing");
    const onMove = (e: PointerEvent) => {
      latest = { ...latest, [key]: Math.max(MIN_COL_WIDTH, Math.round(startWidth + e.clientX - startX)) };
      setSaved(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-col-resizing");
      persist(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function reset(key: string) {
    const next = { ...saved };
    delete next[key];
    setSaved(next);
    persist(next);
  }

  return { widthOf, startResize, reset };
}

/** 列幅のつまみ（見出しの右端） */
function ColResizer({
  label,
  onStart,
  onReset,
}: {
  label: string;
  onStart: (event: React.PointerEvent<HTMLElement>) => void;
  onReset: () => void;
}) {
  return (
    <span
      className="col-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={`${label}の幅`}
      title="ドラッグで幅を変更（ダブルクリックで元の幅）"
      onPointerDown={onStart}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={onReset}
    />
  );
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
    Object.fromEntries(productColumns.map((col) => [col.key, col.width])),
  );
  // 最後の列（状態）以外の幅の合計。画面より広くなったら横にスクロールする
  const fixedWidth =
    IMAGE_COL_WIDTH + productColumns.slice(0, -1).reduce((sum, col) => sum + columnWidths.widthOf(col.key), 0);
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
                  入庫一括でNE更新すると登録されます。今ある在庫をまとめて登録するには「🔄 照合と更新」で「便のない商品も旧原価在庫として登録」を選んで照合してください。
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
                      style={i === productColumns.length - 1 ? undefined : { width: columnWidths.widthOf(col.key) }}
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
                            <ColResizer
                              label={col.label}
                              onStart={(event) => columnWidths.startResize(col.key, event)}
                              onReset={() => columnWidths.reset(col.key)}
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
  // 便がまだない商品を、NEの在庫数・原価（旧NE原価）で登録した在庫
  opening: "旧原価在庫",
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
 * 出荷で減る順番（SQL の cost__reconcile と同じ）：旧原価在庫 → 登録日の古い順 → id の小さい順。
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

  // 表示は新しい順。旧原価在庫はいちばん古い扱い（出荷で最初に減る）なので、登録日に関係なく最後に並べる
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
            <th rowSpan={2} className="num">残り</th>
            <th rowSpan={2} className="num">入庫数</th>
            <th rowSpan={2} className="num">残り金額</th>
            <th
              colSpan={5}
              className="cost-group-head"
              title="NEの数量1つあたりの原価。原価 ＝ 商品 ＋ オプション ＋ 国内運賃 ＋ 国際送料。商品は配送依頼書の元の金額 × レートで円にしています"
            >
              NE数量1原価
            </th>
            <th rowSpan={2}>種類</th>
            <th rowSpan={2}>便</th>
            <th rowSpan={2}>登録日</th>
            <th rowSpan={2}>メモ</th>
          </tr>
          <tr>
            <th className="num cost-col cost-col--first">原価</th>
            <th className="num cost-col"><span className="cost-op">＝</span>商品<small className="th-sub">元 × レート</small></th>
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
                <td className="num strong">
                  <span className="meter" aria-hidden="true" title={`入庫数の${Math.round(ratio * 100)}%が残っています`}>
                    <span style={{ width: `${Math.round(ratio * 100)}%` }} />
                  </span>
                  {count(lot.qtyRemaining)}
                </td>
                <td className="num">{count(lot.qtyIn)}</td>
                <td className="num">{yen(lot.qtyRemaining * (lot.unitCost ?? 0))}</td>
                <td className="num strong cost-col cost-col--first">{unitYen(lot.unitCost)}</td>
                {hasBreakdown(lot) ? (
                  <>
                    <td className="num cost-col">
                      <span className="cost-op">＝</span>
                      {unitYen(lot.unitGoods ?? 0)}
                      <CnyLine yenValue={lot.unitGoods} rate={lot.rate} />
                    </td>
                    <td className="num cost-col">
                      <span className="cost-op">＋</span>
                      {unitYen(lot.unitOption ?? 0)}
                    </td>
                    <td className="num cost-col">
                      <span className="cost-op">＋</span>
                      {unitYen(lot.unitDomestic ?? 0)}
                    </td>
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
                    <span title="NEから在庫数・原価を取ってきて登録した日です（並びは便より古い扱いでいちばん下）">
                      {lot.createdAt ? dateOnly(lot.createdAt) : "—"}
                      <small className="lot-sub">NEから取得</small>
                    </span>
                  ) : (
                    dateOnly(lot.receivedAt)
                  )}
                </td>
                <td className="note">
                  {lot.note ?? ""}
                  {lot.preAppCost !== null && (
                    <span className="pre-app-cost" title="便の原価に置き換える前の、もとのNEの原価（バックアップから）。在庫金額の計算には使っていません">
                      旧NE原価 {unitYen(lot.preAppCost)}
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

/** 商品の円の下に「15.30元 × 24.22円」（元の金額 × 配送依頼書のレート）を小さく出す。レートがない・0円のときは出さない */
function CnyLine({ yenValue, rate }: { yenValue: number | null; rate: number | null }) {
  if (rate === null || yenValue === null || Math.abs(yenValue) < 0.00005) return null;
  return (
    <small className="cost-cny" title={`配送依頼書の元の金額 × レート（1元 ＝ ${rateText(rate)}円）`}>
      {cny(yenValue / rate)} × {rateText(rate)}円
    </small>
  );
}

/** 原価の内訳（商品・オプション・国内運賃・国際送料）があるか。旧原価在庫・調整は内訳がないことが多い */
function hasBreakdown(lot: LotRow): boolean {
  return [lot.unitGoods, lot.unitOption, lot.unitDomestic, lot.unitIntl, lot.unitOther].some((v) => v !== null);
}

/** 「09/15 21:47便」「旧原価在庫」など、在庫の呼び名 */
function lotName(lot: LotRow): string {
  return lot.lotType === "shipment" ? shipmentLabel(lot.shipmentId) : lotTypeLabel[lot.lotType];
}

/* ------------------------------------------------------------------ */
/* 入庫履歴（便ごと）                                                   */
/* ------------------------------------------------------------------ */

export function ShipmentsView({ shipments, top }: { shipments: ShipmentRow[]; top: ReactNode }) {
  const remaining = shipments.reduce((sum, row) => sum + row.valueRemainingJpy, 0);
  return (
    <>
      <main className="content">
        {top}
        <div className="panel">
          <div className="panel-toolbar">
            <h2>🚚 入庫履歴（配送依頼書ごと）</h2>
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

export function SnapshotsView({
  snapshots,
  period,
  onPeriodChange,
  top,
}: {
  snapshots: SnapshotRow[];
  period: Period;
  onPeriodChange: (next: Period) => void;
  top: ReactNode;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const monthEndOnly = period.mode === "monthly";
  const firstDate = useMemo(
    () => snapshots.reduce<string | null>((min, row) => (min === null || row.snapshotDate < min ? row.snapshotDate : min), null),
    [snapshots],
  );
  const range = resolvePeriod(period, firstDate);

  // 日別ならすべての記録、月別なら各月の最後の記録（月末時点）。新しい順
  const series = useMemo(
    () => (monthEndOnly ? monthEndSeries(snapshots) : [...snapshots]).sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate)),
    [snapshots, monthEndOnly],
  );

  // 1つ前（日別は前日、月別は前月末）との比較。入庫・出荷はその間の記録ごとの出入りを合計する（グラフと同じ計算）
  const changes = useMemo(() => snapshotChanges(snapshots, series), [snapshots, series]);

  // 選んでいる期間の行（グラフと同じ期間）
  const rows = useMemo(
    () => series.filter((row) => inPeriod(row.snapshotDate, period.mode, range)),
    [series, period.mode, range.from, range.to],
  );

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
        [
          "日付",
          "照合",
          "在庫金額",
          ...stores.map((store) => `${store}（金額）`),
          "増減",
          "入庫",
          "出荷",
          "在庫数",
          ...stores.map((store) => `${store}（個数）`),
          "商品数",
          "要確認",
        ],
        rows.map((row) => {
          const c = changes.get(row.snapshotDate);
          return [
            row.snapshotDate,
            row.source === "cron" ? "自動" : "手動",
            Math.round(row.totalValueJpy),
            ...stores.map((store) => (row.byStore[store] ? Math.round(row.byStore[store].v) : "")),
            c ? Math.round(c.diff) : "",
            c && c.complete ? Math.round(c.inValue) : "",
            c && c.complete ? Math.round(c.outValue) : "",
            row.totalQty,
            ...stores.map((store) => row.byStore[store]?.q ?? ""),
            row.productCount,
            row.needsReviewCount,
          ];
        }),
      ),
      `在庫推移_${monthEndOnly ? "月別" : "日別"}_${range.from}〜${range.to}.csv`,
    );
  }

  // 列（店舗の列は記録に出てくる店舗の数だけ）。最後の「商品別CSV」の列は残りの幅を使う
  // group：金額のまとまり（在庫金額＋店舗）と、その動き（増減＋入庫・出荷）を薄い背景でまとめる
  type SnapCol = { key: string; label: string; num?: boolean; width: number; group?: "value" | "move"; sub?: boolean; store?: string };
  const snapshotColumns: SnapCol[] = [
    { key: "date", label: "日付", width: 120 },
    { key: "time", label: "記録時刻", width: 90 },
    { key: "value", label: "在庫金額", num: true, width: 140, group: "value" },
    ...stores.map((store): SnapCol => ({ key: `store:${store}`, label: store, num: true, width: 140, group: "value", sub: true, store })),
    { key: "diff", label: "増減", num: true, width: 130, group: "move" },
    { key: "in", label: "入庫", num: true, width: 120, group: "move", sub: true },
    { key: "out", label: "出荷", num: true, width: 120, group: "move", sub: true },
    { key: "qty", label: "在庫数", num: true, width: 110 },
    { key: "products", label: "商品数", num: true, width: 90 },
    { key: "source", label: "照合", width: 80 },
  ];
  const snapshotWidths = useColumnWidths(
    "zaiko_snapshot_col_widths",
    Object.fromEntries(snapshotColumns.map((col) => [col.key, col.width])),
  );
  const snapshotFixedWidth = snapshotColumns.reduce((sum, col) => sum + snapshotWidths.widthOf(col.key), 0);
  const groupClass = (col: SnapCol) => {
    if (!col.group) return "";
    const cols = snapshotColumns.filter((c) => c.group === col.group);
    return [
      `grp grp--${col.group}`,
      cols[0].key === col.key ? "grp-start" : "",
      cols[cols.length - 1].key === col.key ? "grp-end" : "",
      col.sub ? "grp-sub" : "",
    ]
      .filter(Boolean)
      .join(" ");
  };

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

  function changeCell(col: SnapCol, row: SnapshotRow) {
    const c = changes.get(row.snapshotDate);
    if (col.key === "diff") {
      if (!c) return <span className="muted" title="比べる前の記録がありません">—</span>;
      const lines = [
        c.complete ? `入庫 +${yen(c.inValue)}（入庫一括 ${yen(c.received)}・返品や棚卸 ${yen(c.adjusted)}）` : "入庫・出荷：金額を記録する前の期間を含むため不明",
        c.complete ? `出荷 −${yen(c.outValue)}` : "",
        c.complete && Math.round(c.opening) !== 0 ? `旧原価在庫の登録 +${yen(c.opening)}` : "",
        c.complete && Math.abs(c.other) >= 1 ? `その他（原価の置き換えなど） ${c.other >= 0 ? "+" : "−"}${yen(Math.abs(c.other))}` : "",
      ].filter(Boolean);
      return (
        <span className={c.diff > 0 ? "chg-up" : c.diff < 0 ? "chg-down" : "muted"} title={lines.join("\n")}>
          {c.diff > 0 ? "+" : c.diff < 0 ? "−" : "±"}
          {yen(Math.abs(c.diff))}
        </span>
      );
    }
    if (!c || !c.complete) return <span className="muted" title={c ? "金額を記録する前の期間を含むため不明" : undefined}>—</span>;
    const v = col.key === "in" ? c.inValue : c.outValue;
    if (Math.round(v) === 0) return <span className="muted">—</span>;
    return (
      <span title={col.key === "in" ? `入庫一括 ${yen(c.received)}・返品や棚卸 ${yen(c.adjusted)}` : "先入先出の原価"}>
        {col.key === "in" ? "+" : "−"}
        {yen(v)}
      </span>
    );
  }

  return (
    <>
      <main className="content">
        {top}
        {error && <p className="form-error">{error}</p>}
        <div className="panel">
          <div className="panel-toolbar">
            <h2>📅 在庫推移(表)</h2>
            <p className="toolbar-note">1日1件。同じ日に何度照合しても最後の結果で上書きされます。</p>
            <div className="toolbar-spacer" />
            <span className="result-count">{count(rows.length)}件</span>
            <button type="button" className="btn-secondary" onClick={exportList} disabled={rows.length === 0}>
              ⤓ 一覧CSV
            </button>
          </div>
          <PeriodBar period={period} onChange={onPeriodChange} firstDate={firstDate} />
      {snapshots.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📅</div>
          <div className="empty-title">まだ記録がありません</div>
          <div className="empty-desc">「🔄 照合と更新」で照合するか、毎日 21:05 の自動照合で、その日の在庫金額が保存されます。</div>
        </div>
      ) : (
      <div className="tbl-wrap">
        <table className="tbl tbl--resizable tbl--snap" style={{ minWidth: snapshotFixedWidth + 110 }}>
          <colgroup>
            {snapshotColumns.map((col) => (
              <col key={col.key} style={{ width: snapshotWidths.widthOf(col.key) }} />
            ))}
            <col />
          </colgroup>
          <thead>
            <tr>
              {snapshotColumns.map((col) => (
                <th key={col.key} className={[col.num ? "num" : "", groupClass(col)].filter(Boolean).join(" ")}>
                  {col.store && <span className={`store-dot th-dot tone-${storeTone(col.store, stores)}`} aria-hidden="true" />}
                  {col.label}
                  <ColResizer
                    label={col.label}
                    onStart={(event) => snapshotWidths.startResize(col.key, event)}
                    onReset={() => snapshotWidths.reset(col.key)}
                  />
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={snapshotColumns.length + 1} className="month-empty">{periodLabel(range)} の記録はありません</td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.snapshotDate}>
                {snapshotColumns.map((col) => {
                  const cls = [col.num ? "num" : "", groupClass(col)];
                  switch (col.key) {
                    case "date":
                      return <td key={col.key} className="code">{dateOnly(row.snapshotDate)}</td>;
                    case "time":
                      return <td key={col.key} className="muted" title={dateTime(row.takenAt)}>{timeOnly(row.takenAt)}</td>;
                    case "value":
                      return <td key={col.key} className={[...cls, "strong"].join(" ")}>{yen(row.totalValueJpy)}</td>;
                    case "diff":
                    case "in":
                    case "out":
                      return <td key={col.key} className={cls.join(" ")}>{changeCell(col, row)}</td>;
                    case "qty":
                      return <td key={col.key} className="num">{count(row.totalQty)}</td>;
                    case "products":
                      return <td key={col.key} className="num">{count(row.productCount)}</td>;
                    case "source":
                      return (
                        <td key={col.key}>
                          {row.source === "cron" ? <span className="status success">自動</span> : <span className="status monitoring">手動</span>}
                        </td>
                      );
                    default: {
                      const t = col.store ? row.byStore[col.store] : undefined;
                      return (
                        <td key={col.key} className={cls.join(" ")} title={t ? `${count(t.q)}個・${count(t.n)}商品` : "この日は店舗別の内訳がありません"}>
                          {t ? yen(t.v) : <span className="muted">—</span>}
                        </td>
                      );
                    }
                  }
                })}
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
              <th className="num">旧原価在庫</th>
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

/* ------------------------------------------------------------------ */
/* 旧原価との比較                                                       */
/* ------------------------------------------------------------------ */

type OldCostRow = {
  product: ProductRow;
  oldCost: number; // 旧NE原価
  latestCost: number; // 最新の便の原価
  diff: number; // 最新 − 旧（1個あたり）
  rate: number | null; // 差額率（旧原価に対して）
  impact: number; // 在庫数 × 差額
};
type OldCostSortKey = "code" | "name" | "store" | "qty" | "old" | "latest" | "diff" | "rate" | "impact" | "abs";
type OldCostFilter = "all" | "up" | "down";

// 列はすべて決まった幅。表の右側の余りは最後の空の列が受け持つ（数字が右端に寄りすぎないように）
const oldCostColumns: { key: OldCostSortKey; label: string; num?: boolean; firstDir: SortDir; width: number }[] = [
  { key: "code", label: "商品コード", firstDir: "asc", width: 210 },
  { key: "name", label: "商品名", firstDir: "asc", width: 240 },
  { key: "store", label: "店舗", firstDir: "asc", width: 140 },
  { key: "qty", label: "在庫数", num: true, firstDir: "desc", width: 90 },
  { key: "latest", label: "最新原価", num: true, firstDir: "desc", width: 100 },
  { key: "old", label: "旧原価", num: true, firstDir: "desc", width: 100 },
  { key: "diff", label: "差額", num: true, firstDir: "desc", width: 100 },
  { key: "rate", label: "差額率", num: true, firstDir: "desc", width: 90 },
  { key: "impact", label: "在庫金額の差", num: true, firstDir: "desc", width: 130 },
  { key: "abs", label: "影響値（絶対値）", num: true, firstDir: "desc", width: 140 },
];

/** 原価の差の向き。1銭（0.01円）未満は「同じ」。表示の丸めで0円に見える差も、増加・減少に数える */
function diffSign(value: number): -1 | 0 | 1 {
  const r = Math.round(value * 100);
  return r > 0 ? 1 : r < 0 ? -1 : 0;
}
/** 小数2桁の円（¥3.85） */
function yen2(value: number): string {
  return unitYen(value, { digits: 2, mode: "round" });
}
/** 1個あたりの原価の差。表示の桁で0円になってしまう差は小数2桁で出す */
function unitDiffText(value: number): string {
  const sign = diffSign(value);
  if (sign === 0) return `±${unitYen(0)}`;
  const shown = costSign(value) === 0 ? yen2(Math.abs(value)) : unitYen(Math.abs(value));
  return `${sign > 0 ? "+" : "−"}${shown}`;
}
/** 金額の差（在庫金額の差など。円単位） */
function moneyDiffText(value: number): string {
  const r = Math.round(value);
  if (r === 0) return "±¥0";
  return `${r > 0 ? "+" : "−"}${yen(Math.abs(value))}`;
}
function diffClass(value: number): string {
  const sign = diffSign(value);
  return sign > 0 ? "cost-up" : sign < 0 ? "cost-down" : "muted";
}
function pctText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const r = Math.round(value * 1000) / 10;
  return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${Math.abs(r).toFixed(1)}%`;
}
/** 最新原価・旧原価の列の色分け（最新＝藍、旧＝琥珀） */
function colTone(key: OldCostSortKey): string {
  return key === "latest" ? "cmp-new" : key === "old" ? "cmp-old" : "";
}

/** カードの説明文：「〜より ¥173,739（4.2%）低い」 */
function compareSentence(lead: string, diff: number, base: number, unit: (v: number) => string): string {
  if (diffSign(diff) === 0) return `${lead.replace(/より.*$/, "")}と同じです。`;
  const pct = base > 0 ? `（${(Math.round(Math.abs(diff / base) * 1000) / 10).toFixed(1)}%）` : "";
  const shown = costSign(diff) === 0 ? unitYen(Math.abs(diff), { digits: 2, mode: "round" }) : unit(Math.abs(diff));
  return `${lead} ${shown}${pct}${diff > 0 ? "高い" : "低い"}。`;
}

/** CSV向け：小数2桁（丸めの設定に関係なく） */
function csv2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function OldCostView({
  products,
  data,
  top,
}: {
  products: ProductRow[];
  data: OldCostData;
  top: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<OldCostFilter>("all");
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProductRow | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(200);
  // 最初は影響値（在庫金額の差の絶対値）の大きい順。プラスもマイナスも、ズレの大きい商品から
  const [sort, setSort] = useState<{ key: OldCostSortKey; dir: SortDir }>({ key: "abs", dir: "desc" });
  const columnWidths = useColumnWidths(
    "zaiko_oldcost_col_widths",
    Object.fromEntries(oldCostColumns.map((col) => [col.key, col.width])),
  );
  const fixedWidth = IMAGE_COL_WIDTH + oldCostColumns.reduce((sum, col) => sum + columnWidths.widthOf(col.key), 0);

  // 対象：旧NE原価があり、入庫一括で便の原価（新原価）も登録されている商品
  const base = useMemo<OldCostRow[]>(
    () =>
      products.flatMap((product) => {
        const oldCost = data.oldCost[product.productCodeLc];
        if (oldCost === undefined || product.latestUnitCost === null) return [];
        const latestCost = product.latestUnitCost;
        const diff = latestCost - oldCost;
        return [
          {
            product,
            oldCost,
            latestCost,
            diff,
            rate: oldCost > 0 ? diff / oldCost : null,
            impact: product.qty * diff,
          },
        ];
      }),
    [products, data],
  );

  // 上の集計（絞り込みに関係なく、対象の商品すべて）
  const summary = useMemo(() => {
    let oldValue = 0;
    let latestValue = 0;
    let oldSum = 0;
    let latestSum = 0;
    let upValue = 0;
    let downValue = 0;
    let up = 0;
    let down = 0;
    let upDiffSum = 0;
    let downDiffSum = 0;
    for (const row of base) {
      oldValue += row.product.qty * row.oldCost;
      latestValue += row.product.qty * row.latestCost;
      oldSum += row.oldCost;
      latestSum += row.latestCost;
      if (row.impact > 0) upValue += row.impact;
      else downValue += row.impact;
      const sign = diffSign(row.diff);
      if (sign > 0) {
        up += 1;
        upDiffSum += row.diff;
      } else if (sign < 0) {
        down += 1;
        downDiffSum += row.diff;
      }
    }
    const n = base.length;
    return {
      n,
      oldValue,
      latestValue,
      upValue,
      downValue,
      oldAvg: n ? oldSum / n : 0,
      latestAvg: n ? latestSum / n : 0,
      up,
      down,
      upDiffSum,
      downDiffSum,
      same: n - up - down,
    };
  }, [base]);
  // 旧原価がある商品（このうち新原価も登録されたものが対象）
  const withOldCost = useMemo(() => products.filter((p) => p.productCodeLc in data.oldCost).length, [products, data]);

  const storeOrder = useMemo(() => {
    const value = new Map<string, number>();
    for (const row of products) value.set(row.store, (value.get(row.store) ?? 0) + row.valueJpy);
    return sortStores(value.keys(), (store) => value.get(store) ?? 0);
  }, [products]);
  const storesInBase = useMemo(() => storeOrder.filter((store) => base.some((row) => row.product.store === store)), [storeOrder, base]);

  function toggleSort(key: OldCostSortKey) {
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : { key, dir: oldCostColumns.find((col) => col.key === key)?.firstDir ?? "asc" },
    );
  }

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = base.filter((row) => {
      if (filter === "up" && diffSign(row.diff) <= 0) return false;
      if (filter === "down" && diffSign(row.diff) >= 0) return false;
      if (storeFilter !== null && row.product.store !== storeFilter) return false;
      if (!q) return true;
      return row.product.productCodeLc.includes(q) || row.product.productName.toLowerCase().includes(q);
    });
    const pick = (row: OldCostRow): number | string => {
      switch (sort.key) {
        case "abs": return Math.abs(row.impact);
        case "code": return row.product.productCodeLc;
        case "name": return row.product.productName;
        case "store": return row.product.store;
        case "qty": return row.product.qty;
        case "old": return row.oldCost;
        case "latest": return row.latestCost;
        case "diff": return row.diff;
        case "rate": return row.rate ?? Number.NEGATIVE_INFINITY;
        case "impact": return row.impact;
      }
    };
    const sign = sort.dir === "asc" ? 1 : -1;
    return filtered.sort((a, b) => {
      const va = pick(a);
      const vb = pick(b);
      const c = typeof va === "string" ? textCollator.compare(va, vb as string) : va - (vb as number);
      return sign * c || a.product.productCodeLc.localeCompare(b.product.productCodeLc);
    });
  }, [base, query, filter, storeFilter, sort]);

  // 一覧に出ている商品の内訳（絞り込み・検索に合わせる）
  const rowSplit = useMemo(() => {
    let up = 0;
    let down = 0;
    for (const row of rows) {
      const sign = diffSign(row.diff);
      if (sign > 0) up += 1;
      else if (sign < 0) down += 1;
    }
    return { up, down, same: rows.length - up - down };
  }, [rows]);

  function exportCsv() {
    downloadBlob(
      csvBlob(
        ["商品コード", "商品名", "店舗", "在庫数", "最新原価", "旧原価", "差額", "差額率(%)", "在庫金額の差", "影響値（絶対値）"],
        rows.map((row) => [
          row.product.productCode,
          row.product.productName,
          row.product.store,
          row.product.qty,
          csv2(row.latestCost),
          csv2(row.oldCost),
          csv2(row.diff),
          row.rate === null ? "" : Math.round(row.rate * 1000) / 10,
          Math.round(row.impact),
          Math.round(Math.abs(row.impact)),
        ]),
      ),
      `旧原価との比較${storeFilter ? `_${storeFilter}` : ""}_${todayJst()}.csv`,
    );
  }

  const valueDiff = summary.latestValue - summary.oldValue;
  const avgDiff = summary.latestAvg - summary.oldAvg;

  return (
    <>
      <main className="content">
        {top}
        <div className="cmp-scope">
          <span className="cmp-scope-tag">対象</span>
          <span className="cmp-scope-text">旧原価があり、新原価が登録されている商品のみ</span>
          <span className="cmp-scope-count" title="対象の商品数 ／ 旧原価がある商品数">
            対象商品数／旧原価
            <b>{count(summary.n)}</b>
            <span>／ {count(withOldCost)}商品</span>
            {withOldCost > 0 && <small>（{(Math.round((summary.n / withOldCost) * 1000) / 10).toFixed(1)}%）</small>}
          </span>
        </div>
        <div className="cmp-cards">
          <section className="cmp-card">
            <h3>在庫金額<small>今の在庫数 × 原価の合計</small></h3>
            <div className="cmp-line cmp-line--main cmp-new"><span><i className="cmp-key" aria-hidden="true" />最新原価で計算</span><b>{yen(summary.latestValue)}</b></div>
            <div className="cmp-line cmp-old"><span><i className="cmp-key" aria-hidden="true" />旧原価で計算</span><b>{yen(summary.oldValue)}</b></div>
            <div className="cmp-diff">
              <span>差（最新 − 旧）</span>
              <b className={diffClass(valueDiff)}>{moneyDiffText(valueDiff)}</b>
              <small>{pctText(summary.oldValue > 0 ? valueDiff / summary.oldValue : null)}</small>
            </div>
            <p className="cmp-sentence">{compareSentence("最新原価で計算した在庫金額は、旧原価より", valueDiff, summary.oldValue, yen)}</p>
            <div className="cmp-breakdown">
              <span>
                上昇商品の増加額
                <b className="cost-up">{moneyDiffText(summary.upValue)}</b>
              </span>
              <span>
                下落商品の減少額
                <b className="cost-down">{moneyDiffText(summary.downValue)}</b>
              </span>
            </div>
          </section>
          <section className="cmp-card">
            <h3>平均原価<small>1商品あたりの原価の平均（在庫数は考えない）</small></h3>
            <div className="cmp-line cmp-line--main cmp-new"><span><i className="cmp-key" aria-hidden="true" />最新原価平均</span><b>{unitYen(summary.latestAvg)}</b></div>
            <div className="cmp-line cmp-old"><span><i className="cmp-key" aria-hidden="true" />旧原価平均</span><b>{unitYen(summary.oldAvg)}</b></div>
            <div className="cmp-diff">
              <span>差（最新 − 旧）</span>
              <b className={diffClass(avgDiff)}>{unitDiffText(avgDiff)}</b>
              <small>{pctText(summary.oldAvg > 0 ? avgDiff / summary.oldAvg : null)}</small>
            </div>
            <p className="cmp-sentence">{compareSentence("最新原価は、旧原価より1商品あたり平均", avgDiff, summary.oldAvg, (v) => unitYen(v))}</p>
            <div className="cmp-breakdown">
              <span>
                上昇商品の平均差（{count(summary.up)}商品）
                <b className="cost-up">{summary.up ? unitDiffText(summary.upDiffSum / summary.up) : "—"}</b>
              </span>
              <span>
                下落商品の平均差（{count(summary.down)}商品）
                <b className="cost-down">{summary.down ? unitDiffText(summary.downDiffSum / summary.down) : "—"}</b>
              </span>
            </div>
          </section>
        </div>
        <div className="panel">
          <div className="panel-toolbar">
            <h2>⚖️ 旧原価との比較</h2>
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
                  ["all", "すべて", summary.n],
                  ["up", "増加商品", summary.up],
                  ["down", "減少商品", summary.down],
                ] as const
              ).map(([key, label, n]) => (
                <button key={key} type="button" className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>
                  {label}
                  <span className="seg-cnt">{n}</span>
                </button>
              ))}
            </div>
            {storesInBase.length > 1 && (
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
                  {storesInBase.map((store) => (
                    <option key={store} value={store}>
                      {store}（{count(base.filter((row) => row.product.store === store).length)}）
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="toolbar-spacer" />
            <span className="result-count cmp-result">
              {count(rows.length)}商品
              <span className="cmp-split">
                <span><b className="cost-up">▲ {count(rowSplit.up)}</b> 増加商品</span>
                <span><b className="cost-down">▼ {count(rowSplit.down)}</b> 減少商品</span>
                <span><b className="muted">― {count(rowSplit.same)}</b> 同じ</span>
              </span>
            </span>
            <button type="button" className="btn-add" onClick={exportCsv} disabled={rows.length === 0}>
              ⤓ CSV出力
            </button>
          </div>
          {rows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">⚖️</div>
              <div className="empty-title">{base.length === 0 ? "比べられる商品がまだありません" : "条件に合う商品がありません"}</div>
              {base.length === 0 && (
                <div className="empty-desc">
                  旧NE原価（旧原価在庫のメモ）があり、入庫一括で便の原価が登録された商品が、ここに並びます。
                </div>
              )}
            </div>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl tbl--resizable" style={{ minWidth: fixedWidth + MIN_COL_WIDTH + 30 }}>
                <colgroup>
                  <col style={{ width: IMAGE_COL_WIDTH }} />
                  {oldCostColumns.map((col) => (
                    <col key={col.key} style={{ width: columnWidths.widthOf(col.key) }} />
                  ))}
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th className="thumb-cell" aria-label="画像" />
                    {oldCostColumns.map((col) => {
                      const active = sort.key === col.key;
                      return (
                        <th
                          key={col.key}
                          className={[col.num ? "num" : "", colTone(col.key)].filter(Boolean).join(" ") || undefined}
                          aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                        >
                          <button
                            type="button"
                            className={`th-sort ${active ? "is-active" : ""}`}
                            onClick={() => toggleSort(col.key)}
                            title={
                              col.key === "diff"
                                ? "最新原価 − 旧原価（1個あたり）"
                                : col.key === "impact"
                                  ? "在庫数 × 差額（最新原価で計算した在庫金額 − 旧原価で計算した在庫金額）"
                                  : col.key === "rate"
                                    ? "差額 ÷ 旧原価"
                                    : col.key === "abs"
                                      ? "在庫金額の差の絶対値（プラス・マイナスに関係なく、ズレの大きさ）"
                                      : `${col.label}で並び替え`
                            }
                          >
                            {colTone(col.key) && <i className="cmp-key" aria-hidden="true" />}
                            {col.label}
                            <span className="th-sort-icon" aria-hidden="true">
                              {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                            </span>
                          </button>
                          <ColResizer
                            label={col.label}
                            onStart={(event) => columnWidths.startResize(col.key, event)}
                            onReset={() => columnWidths.reset(col.key)}
                          />
                        </th>
                      );
                    })}
                    <th aria-hidden="true" />
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, limit).map((row) => {
                    const p = row.product;
                    const isOpen = expanded === p.productCodeLc;
                    // 表示の桁で旧原価と最新原価が同じに見えるのに差があるときは、両方を小数2桁で出す
                    const fine = diffSign(row.diff) !== 0 && costSign(row.diff) === 0;
                    const costText = (v: number) => (fine ? yen2(v) : unitYen(v));
                    return (
                      <Fragment key={p.productCodeLc}>
                        <tr className={`row-clickable ${isOpen ? "is-open" : ""}`} onClick={() => setExpanded(isOpen ? null : p.productCodeLc)}>
                          <td className="thumb-cell">
                            <ProductThumb row={p} onPreview={setPreview} />
                          </td>
                          {oldCostColumns.map((col) => {
                            switch (col.key) {
                              case "code":
                                return (
                                  <td key={col.key} className="code" title={p.productCode}>
                                    <span className="chevron" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                                    {p.productCode}
                                  </td>
                                );
                              case "name":
                                return <td key={col.key} className="name" title={p.productName}>{p.productName}</td>;
                              case "store":
                                return (
                                  <td key={col.key} title={p.goodsTag ?? "商品分類タグなし"}>
                                    <StoreBadge store={p.store} order={storeOrder} />
                                  </td>
                                );
                              case "qty":
                                return <td key={col.key} className="num">{count(p.qty)}</td>;
                              case "old":
                                return <td key={col.key} className="num cmp-old">{costText(row.oldCost)}</td>;
                              case "latest":
                                return <td key={col.key} className="num strong cmp-new">{costText(row.latestCost)}</td>;
                              case "diff":
                                return <td key={col.key} className={`num ${diffClass(row.diff)}`}>{unitDiffText(row.diff)}</td>;
                              case "rate":
                                return <td key={col.key} className={`num ${diffClass(row.diff)}`}>{pctText(row.rate)}</td>;
                              case "impact":
                                return (
                                  <td key={col.key} className={`num ${diffClass(row.impact)}`}>
                                    {p.qty === 0 ? <span className="muted">—</span> : moneyDiffText(row.impact)}
                                  </td>
                                );
                              case "abs":
                                return (
                                  <td key={col.key} className="num strong">
                                    {p.qty === 0 ? <span className="muted">—</span> : yen(Math.abs(row.impact))}
                                  </td>
                                );
                            }
                          })}
                          <td aria-hidden="true" />
                        </tr>
                        {isOpen && (
                          <tr className="detail-row">
                            <td colSpan={oldCostColumns.length + 2}>
                              <LotDetail productCodeLc={p.productCodeLc} />
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
