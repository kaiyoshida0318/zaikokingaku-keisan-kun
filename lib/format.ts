export function yen(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `¥${value.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/* ------------------------------------------------------------------ */
/* 原価（単価）の小数点の丸め：設定画面で選ぶ。表示とCSVの単価だけに使い、在庫金額の計算には使わない */
/* ------------------------------------------------------------------ */

export type CostRoundingMode = "round" | "floor" | "ceil";
export type CostRounding = { digits: 0 | 1 | 2; mode: CostRoundingMode };

export const DEFAULT_COST_ROUNDING: CostRounding = { digits: 0, mode: "round" };
const COST_ROUNDING_STORAGE_KEY = "zaiko_cost_rounding";

let costRounding: CostRounding = DEFAULT_COST_ROUNDING;

export function getCostRounding(): CostRounding {
  return costRounding;
}

/** 丸めの設定を変える（persist=true ならこのブラウザに保存） */
export function setCostRounding(next: CostRounding, persist = true): void {
  costRounding = next;
  if (!persist) return;
  try {
    window.localStorage.setItem(COST_ROUNDING_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 保存できなくても、この画面の間は使える
  }
}

/** このブラウザに保存された設定（なければ初期値：整数・四捨五入） */
export function loadCostRounding(): CostRounding {
  try {
    const raw = JSON.parse(window.localStorage.getItem(COST_ROUNDING_STORAGE_KEY) ?? "null") as Partial<CostRounding> | null;
    const digits = raw?.digits === 1 || raw?.digits === 2 ? raw.digits : 0;
    const mode = raw?.mode === "floor" || raw?.mode === "ceil" ? raw.mode : "round";
    return raw ? { digits, mode } : DEFAULT_COST_ROUNDING;
  } catch {
    return DEFAULT_COST_ROUNDING;
  }
}

/** 原価を設定どおりに丸める（浮動小数の誤差で 472.5 が 472.49999… になるのを避ける） */
export function roundCost(value: number, rounding: CostRounding = costRounding): number {
  const f = 10 ** rounding.digits;
  const scaled = value * f;
  const r =
    rounding.mode === "floor"
      ? Math.floor(scaled + 1e-9)
      : rounding.mode === "ceil"
        ? Math.ceil(scaled - 1e-9)
        : Math.sign(scaled) * Math.round(Math.abs(scaled) + 1e-9);
  return r / f;
}

/** 単価向け：設定の桁数・丸め方で表示 */
export function unitYen(value: number | null | undefined, rounding: CostRounding = costRounding): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return yen(roundCost(value, rounding), rounding.digits);
}

/** 人民元（小数2桁）。例：12.47元 */
export function cny(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}元`;
}

/** レート（1元＝何円）。小数2桁（それより細かいレートは最大4桁まで） */
export function rateText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** CSV向け：丸めた原価（空は空欄） */
export function unitCsv(value: number | null | undefined): number | "" {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return roundCost(value);
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("ja-JP");
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 時刻だけ（日本時間の 21:05） */
export function timeOnly(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
}

export function dateOnly(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });
}

/** P2026091008463813-2147 → 09/10 08:46便 */
export function shipmentLabel(id: string | null | undefined): string {
  if (!id) return "—";
  const m = id.match(/^P(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}便` : id;
}

/** 配送依頼書番号 → ラクマートの配送詳細ページ */
export function rakumartDeliveryUrl(id: string | null | undefined): string | null {
  if (!id) return null;
  return `https://www.rakumart.com/deliveryDetails?pOrder_sn=${encodeURIComponent(id)}`;
}

export function csvBlob(headers: string[], rows: Array<Array<string | number | null | undefined>>): Blob {
  const escape = (value: string | number | null | undefined) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const body = [headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n");
  // ExcelでそのままひらけるようにBOM付きUTF-8
  return new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" });
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function todayJst(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}
