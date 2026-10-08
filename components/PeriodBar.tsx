"use client";

import { todayJst } from "@/lib/format";

/**
 * 在庫推移の表示期間（表とグラフで共通。タブを切り替えても同じ期間のまま）。
 * 日別は日付（yyyy-mm-dd）、月別は月（yyyy-mm）で期間を持つ。
 */
export type PeriodMode = "daily" | "monthly";
export type PeriodPreset = "prevToNow" | "thisMonth" | "thisYear" | "year" | "all" | "custom";
export type Period = {
  mode: PeriodMode;
  preset: PeriodPreset;
  /** preset が custom のときの期間（日別は yyyy-mm-dd、月別は yyyy-mm） */
  from: string;
  to: string;
};

export const DEFAULT_PERIOD: Period = { mode: "daily", preset: "prevToNow", from: "", to: "" };

const PRESETS: Array<[Exclude<PeriodPreset, "custom">, string]> = [
  ["prevToNow", "先月〜今月"],
  ["thisMonth", "今月"],
  ["thisYear", "今年"],
  ["year", "1年"],
  ["all", "全期間"],
];

/* ---------- 日付の計算（yyyy-mm-dd / yyyy-mm の文字列のまま扱う） ---------- */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
/** yyyy-mm に n か月足す */
export function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${pad2(mm + 1)}`;
}
/** yyyy-mm-dd に n 日足す */
function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
/** 1年前の翌日（うるう日の2/29は、前年の3/1を1年前として数える） */
function oneYearBefore(date: string): string {
  const t = Date.UTC(Number(date.slice(0, 4)) - 1, Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return addDays(new Date(t).toISOString().slice(0, 10), 1);
}
/** その月の最後の日（yyyy-mm-dd） */
function monthLastDay(month: string): string {
  return addDays(`${addMonths(month, 1)}-01`, -1);
}
function minStr(a: string, b: string): string {
  return a < b ? a : b;
}

/** 選んでいる期間を、日別なら日付・月別なら月の「から〜まで」にする（全期間は最初の記録から） */
export function resolvePeriod(period: Period, firstDate: string | null, today = todayJst()): { from: string; to: string } {
  const thisMonth = today.slice(0, 7);
  if (period.mode === "daily") {
    switch (period.preset) {
      case "prevToNow":
        return { from: `${addMonths(thisMonth, -1)}-01`, to: today };
      case "thisMonth":
        return { from: `${thisMonth}-01`, to: today };
      case "thisYear":
        return { from: `${today.slice(0, 4)}-01-01`, to: today };
      case "year":
        // 1年前の翌日から今日まで（例：2025/10/09〜2026/10/08）
        return { from: oneYearBefore(today), to: today };
      case "all":
        return { from: minStr(firstDate ?? today, today), to: today };
      default: {
        const from = period.from || today;
        const to = period.to || today;
        return from <= to ? { from, to } : { from: to, to: from };
      }
    }
  }
  switch (period.preset) {
    case "prevToNow":
      return { from: addMonths(thisMonth, -1), to: thisMonth };
    case "thisMonth":
      return { from: thisMonth, to: thisMonth };
    case "thisYear":
      return { from: `${today.slice(0, 4)}-01`, to: thisMonth };
    case "year":
      // 今月を含めて12か月
      return { from: addMonths(thisMonth, -11), to: thisMonth };
    case "all":
      return { from: minStr((firstDate ?? today).slice(0, 7), thisMonth), to: thisMonth };
    default: {
      const from = period.from || thisMonth;
      const to = period.to || thisMonth;
      return from <= to ? { from, to } : { from: to, to: from };
    }
  }
}

/** 記録の日付（yyyy-mm-dd）が、選んでいる期間に入るか */
export function inPeriod(date: string, mode: PeriodMode, range: { from: string; to: string }): boolean {
  const key = mode === "daily" ? date : date.slice(0, 7);
  return key >= range.from && key <= range.to;
}

/** 期間の表示（2026/09/01〜2026/10/08、2026/09〜2026/10） */
export function periodLabel(range: { from: string; to: string }): string {
  const f = range.from.split("-").join("/");
  const t = range.to.split("-").join("/");
  return f === t ? f : `${f}〜${t}`;
}

/**
 * 日別／月別の切り替え、期間のボタン（先月〜今月・今月・今年・1年・全期間）、カレンダーでの期間指定。
 * firstDate は最初の記録の日付（全期間・カレンダーの下限に使う）
 */
export default function PeriodBar({
  period,
  onChange,
  firstDate,
}: {
  period: Period;
  onChange: (next: Period) => void;
  firstDate: string | null;
}) {
  const today = todayJst();
  const range = resolvePeriod(period, firstDate, today);
  const daily = period.mode === "daily";

  function switchMode(mode: PeriodMode) {
    if (mode === period.mode) return;
    if (period.preset !== "custom") {
      onChange({ ...period, mode });
      return;
    }
    // 自分で選んだ期間は、もう一方の単位に直して引き継ぐ
    onChange(
      mode === "monthly"
        ? { mode, preset: "custom", from: range.from.slice(0, 7), to: range.to.slice(0, 7) }
        : { mode, preset: "custom", from: `${range.from}-01`, to: minStr(monthLastDay(range.to), today) },
    );
  }

  function setRange(from: string, to: string) {
    if (!from || !to) return;
    onChange({ mode: period.mode, preset: "custom", from, to });
  }

  const min = firstDate ? (daily ? firstDate : firstDate.slice(0, 7)) : undefined;
  const max = daily ? today : today.slice(0, 7);

  return (
    <div className="period-bar">
      <div className="seg" role="group" aria-label="日別・月別">
        <button type="button" className={daily ? "active" : ""} onClick={() => switchMode("daily")}>
          日別
        </button>
        <button type="button" className={!daily ? "active" : ""} onClick={() => switchMode("monthly")}>
          月別(月末時)
        </button>
      </div>
      <div className="period-presets" role="group" aria-label="期間">
        {PRESETS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`period-chip ${period.preset === key ? "is-on" : ""}`}
            onClick={() => onChange({ ...period, preset: key })}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={`period-range ${period.preset === "custom" ? "is-custom" : ""}`}>
        <input
          type={daily ? "date" : "month"}
          value={range.from}
          min={min}
          max={max}
          aria-label="期間のはじめ"
          onChange={(event) => setRange(event.target.value, range.to)}
        />
        <span>〜</span>
        <input
          type={daily ? "date" : "month"}
          value={range.to}
          min={min}
          max={max}
          aria-label="期間のおわり"
          onChange={(event) => setRange(range.from, event.target.value)}
        />
      </div>
    </div>
  );
}
