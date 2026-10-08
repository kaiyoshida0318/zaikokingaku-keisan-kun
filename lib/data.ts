import { NE_SYNC_WORKER_URL, supabase } from "./supabaseClient";

export type ProductRow = {
  productCode: string;
  productCodeLc: string;
  productName: string;
  qty: number;
  valueJpy: number;
  avgUnitCost: number | null;
  latestUnitCost: number | null;
  openLots: number;
  needsReview: boolean;
  /** 店舗（NEの商品分類タグから判定）。判定できない商品は UNSET_STORE */
  store: string;
  goodsTag: string | null;
  /** 商品画像のURL（商品DBと同じ Supabase Storage の product-images/商品コード.webp）。ないときは画面で非表示 */
  imageUrl: string;
};

/** 商品DBと同じ置き場所の商品画像（public バケット product-images に「商品コード.webp」） */
const PRODUCT_IMAGE_BUCKET = "product-images";
export function productImageUrl(productCode: string): string {
  const code = productCode.trim();
  if (!code || !supabase) return "";
  return supabase.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(`${code}.webp`).data.publicUrl ?? "";
}

/** 店舗が判定できない商品の表示名 */
export const UNSET_STORE = "未設定";
/** 違う店舗のタグが2つ以上付いている商品 */
export const MULTI_STORE = "複数";

export type StoreTotals = { v: number; q: number; n: number };

export type LotRow = {
  id: number;
  productCode: string;
  lotType: "shipment" | "opening" | "adjust";
  shipmentId: string | null;
  receivedAt: string;
  qtyIn: number;
  qtyRemaining: number;
  unitCost: number | null;
  unitGoods: number | null;
  unitOption: number | null;
  unitDomestic: number | null;
  unitIntl: number | null;
  unitOther: number | null;
  needsReview: boolean;
  note: string | null;
  /** 行を作った日時（旧原価在庫では、NEから在庫数・原価を取ってきた日） */
  createdAt: string;
  /** 旧原価在庫のメモ：旧NE原価（便の原価に置き換える前のNEの原価。バックアップから。計算には使わない） */
  preAppCost: number | null;
  /** 便の配送依頼書レート（1元＝何円）。商品・オプション・国内運賃は「元 × レート」で円にしている。便でない在庫は null */
  rate: number | null;
};

export type ShipmentRow = {
  shipmentId: string;
  processedAt: string;
  rate: number;
  totalJpy: number;
  intlFreightJpy: number;
  chargeableKg: number;
  intlMethod: string;
  unallocatedJpy: number;
  qtyIn: number;
  qtyRemaining: number;
  valueInJpy: number;
  valueRemainingJpy: number;
  productCount: number;
  needsReview: boolean;
};

export type SnapshotRow = {
  snapshotDate: string;
  takenAt: string;
  source: string;
  totalValueJpy: number;
  totalQty: number;
  productCount: number;
  needsReviewCount: number;
  /** 店舗別の内訳（店舗に対応する前の記録は空） */
  byStore: Record<string, StoreTotals>;
  /** 前回の記録からの出入りの金額（照合ログから。ビューがない・最初の記録は null） */
  movement: SnapshotMovement | null;
};

export type SnapshotMovement = {
  receivedValue: number; // 入庫一括で登録した分
  adjustedValue: number; // 在庫増の調整（返品・棚卸増など）
  openingValue: number; // 旧原価在庫の登録
  shippedValue: number; // 出荷（先入先出の原価）
  complete: boolean; // 金額を記録する前のログが混じっていない
};

export type LogRow = {
  id: number;
  productCode: string;
  loggedAt: string;
  event: string;
  shipmentId: string | null;
  neStock: number | null;
  lotsQtyBefore: number | null;
  consumed: number;
  adjusted: number;
  opening: number;
  added: number;
};

const PAGE = 1000;

function client() {
  if (!supabase) throw new Error("Supabaseが未設定です。");
  return supabase;
}

function friendly(error: { message?: string; code?: string } | null): Error {
  const message = error?.message ?? "Supabaseの読み込みに失敗しました。";
  if (error?.code === "42P01" || error?.code === "PGRST205" || /does not exist|Could not find/i.test(message)) {
    return new Error("Supabaseにテーブルがありません。cost_lots.sql と zaiko_kingaku.sql をSQL Editorで実行してください。");
  }
  return new Error(message);
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message?: string; code?: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw friendly(error);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export async function fetchProducts(): Promise<ProductRow[]> {
  const db = client();
  type Raw = Record<string, unknown>;
  const [rows, names, stores] = await Promise.all([
    fetchAll<Raw>((from, to) =>
      db.from("cost_inventory_by_product").select("*").order("product_code_lc").range(from, to),
    ),
    fetchAll<Raw>((from, to) =>
      db.from("products").select("product_code,product_name").order("product_code").range(from, to),
    ).catch(() => [] as Raw[]),
    // zaiko_kingaku.sql の店舗部分をまだ実行していなくても、商品一覧は表示する
    fetchAll<Raw>((from, to) =>
      db.from("cost_product_store").select("product_code_lc,goods_tag,store").order("product_code_lc").range(from, to),
    ).catch(() => [] as Raw[]),
  ]);
  const nameByCode = new Map(
    names.map((row) => [String(row.product_code ?? "").toLowerCase(), String(row.product_name ?? "")]),
  );
  // 画像のファイル名は商品DBの商品コードどおり（大文字・小文字を合わせる）
  const dbCodeByLc = new Map(
    names.map((row) => [String(row.product_code ?? "").toLowerCase(), String(row.product_code ?? "")]),
  );
  const storeByCode = new Map(stores.map((row) => [String(row.product_code_lc ?? ""), row]));
  return rows.map((row) => ({
    productCode: String(row.product_code ?? ""),
    productCodeLc: String(row.product_code_lc ?? ""),
    productName: nameByCode.get(String(row.product_code_lc ?? "")) ?? "",
    qty: num(row.qty),
    valueJpy: num(row.value_jpy),
    avgUnitCost: numOrNull(row.avg_unit_cost),
    latestUnitCost: numOrNull(row.latest_unit_cost),
    openLots: num(row.open_lots),
    needsReview: Boolean(row.needs_review),
    store: String(storeByCode.get(String(row.product_code_lc ?? ""))?.store ?? "") || UNSET_STORE,
    goodsTag: (storeByCode.get(String(row.product_code_lc ?? ""))?.goods_tag as string | null | undefined) ?? null,
    imageUrl: productImageUrl(dbCodeByLc.get(String(row.product_code_lc ?? "")) ?? String(row.product_code ?? "")),
  }));
}

/** 旧原価との比較に使うデータ */
export type OldCostData = {
  /** 商品コード小文字 → 旧NE原価（旧原価在庫のメモ。バックアップから入れた、便の原価に置き換える前のNEの原価） */
  oldCost: Record<string, number>;
  /** 商品コード小文字 → いちばん新しい便の配送依頼書番号（最新原価の出どころ。商品一覧の「最新の便の原価」と同じ便） */
  latestShipment: Record<string, string>;
};

/** 旧原価との比較のデータ。列がまだない・読めないときは空 */
export async function fetchOldCostData(): Promise<OldCostData> {
  const db = client();
  type Raw = Record<string, unknown>;
  const [olds, lots] = await Promise.all([
    fetchAll<Raw>((from, to) =>
      db
        .from("cost_lots")
        .select("id,product_code_lc,pre_app_cost")
        .eq("lot_type", "opening")
        .not("pre_app_cost", "is", null)
        .order("id")
        .range(from, to),
    ).catch(() => [] as Raw[]),
    // cost_inventory_by_product の latest_unit_cost と同じ並び（登録日の新しい順 → id の大きい順）
    fetchAll<Raw>((from, to) =>
      db
        .from("cost_lots")
        .select("id,product_code_lc,shipment_id,received_at")
        .eq("lot_type", "shipment")
        .order("received_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to),
    ).catch(() => [] as Raw[]),
  ]);
  const oldCost: Record<string, number> = {};
  for (const row of olds) {
    const code = String(row.product_code_lc ?? "");
    const cost = numOrNull(row.pre_app_cost);
    if (code && cost !== null && !(code in oldCost)) oldCost[code] = cost;
  }
  const latestShipment: Record<string, string> = {};
  for (const row of lots) {
    const code = String(row.product_code_lc ?? "");
    const id = String(row.shipment_id ?? "");
    if (code && id && !(code in latestShipment)) latestShipment[code] = id;
  }
  return { oldCost, latestShipment };
}

/** cost_lots に埋め込んだ cost_shipments(rate) からレートを取り出す（0・不明は null） */
function shipmentRate(embedded: unknown): number | null {
  const row = Array.isArray(embedded) ? embedded[0] : embedded;
  const rate = numOrNull((row as { rate?: unknown } | null | undefined)?.rate);
  return rate && rate > 0 ? rate : null;
}

export async function fetchLots(productCodeLc: string): Promise<LotRow[]> {
  const query = (columns: string) =>
    client()
      .from("cost_lots")
      .select(columns)
      .eq("product_code_lc", productCodeLc)
      .order("received_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(200);
  // 便のレートも一緒に取る。取れない環境（便テーブルとのつながりがない等）ではレートなしで読む
  let { data, error } = await query("*,cost_shipments(rate)");
  if (error) ({ data, error } = await query("*"));
  if (error) throw friendly(error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
    id: num(row.id),
    productCode: String(row.product_code ?? ""),
    lotType: (row.lot_type as LotRow["lotType"]) ?? "shipment",
    shipmentId: (row.shipment_id as string | null) ?? null,
    receivedAt: String(row.received_at ?? ""),
    qtyIn: num(row.qty_in),
    qtyRemaining: num(row.qty_remaining),
    unitCost: numOrNull(row.unit_cost),
    unitGoods: numOrNull(row.unit_goods),
    unitOption: numOrNull(row.unit_option),
    unitDomestic: numOrNull(row.unit_domestic),
    unitIntl: numOrNull(row.unit_intl),
    unitOther: numOrNull(row.unit_other),
    needsReview: Boolean(row.needs_review),
    note: (row.note as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    preAppCost: numOrNull(row.pre_app_cost),
    rate: shipmentRate(row.cost_shipments),
  }));
}

export async function fetchShipments(): Promise<ShipmentRow[]> {
  const db = client();
  type Raw = Record<string, unknown>;
  const [shipments, remains] = await Promise.all([
    fetchAll<Raw>((from, to) =>
      db
        .from("cost_shipments")
        .select("shipment_id,processed_at,rate,total_jpy,intl_freight_jpy,chargeable_kg,intl_method,unallocated_jpy")
        .order("shipment_id", { ascending: false })
        .range(from, to),
    ),
    fetchAll<Raw>((from, to) => db.from("cost_inventory_by_shipment").select("*").range(from, to)),
  ]);
  const remainById = new Map(remains.map((row) => [String(row.shipment_id), row]));
  return shipments.map((row) => {
    const remain = remainById.get(String(row.shipment_id)) ?? {};
    return {
      shipmentId: String(row.shipment_id),
      processedAt: String(row.processed_at ?? ""),
      rate: num(row.rate),
      totalJpy: num(row.total_jpy),
      intlFreightJpy: num(row.intl_freight_jpy),
      chargeableKg: num(row.chargeable_kg),
      intlMethod: String(row.intl_method ?? ""),
      unallocatedJpy: num(row.unallocated_jpy),
      qtyIn: num(remain.qty_in),
      qtyRemaining: num(remain.qty_remaining),
      valueInJpy: num(remain.value_in_jpy),
      valueRemainingJpy: num(remain.value_remaining_jpy),
      productCount: num(remain.product_count),
      needsReview: Boolean(remain.needs_review),
    };
  });
}

export async function fetchSnapshots(): Promise<SnapshotRow[]> {
  const base = "snapshot_date,taken_at,source,total_value_jpy,total_qty,product_count,needs_review_count";
  const query = (columns: string) =>
    client().from("cost_inventory_snapshots").select(columns).order("snapshot_date", { ascending: false }).limit(400);
  let { data, error } = await query(`${base},by_store`);
  // by_store 列がまだない（SQL未実行）ときは店舗なしで読む
  if (error) ({ data, error } = await query(base));
  if (error) throw friendly(error);
  // 前回の記録からの出入り（cost_snapshot_movements がまだなければ出入りなし）
  const movements = new Map<string, SnapshotMovement>();
  const mv = await client()
    .from("cost_snapshot_movements")
    .select("snapshot_date,prev_at,received_value,adjusted_value,opening_value,shipped_value,values_complete")
    .order("snapshot_date", { ascending: false })
    .limit(400);
  if (!mv.error) {
    for (const row of (mv.data ?? []) as Record<string, unknown>[]) {
      if (!row.prev_at) continue; // 最初の記録は比べる相手がない
      movements.set(String(row.snapshot_date), {
        receivedValue: num(row.received_value),
        adjustedValue: num(row.adjusted_value),
        openingValue: num(row.opening_value),
        shippedValue: num(row.shipped_value),
        complete: Boolean(row.values_complete),
      });
    }
  }
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
    snapshotDate: String(row.snapshot_date),
    takenAt: String(row.taken_at ?? ""),
    source: String(row.source ?? ""),
    totalValueJpy: num(row.total_value_jpy),
    totalQty: num(row.total_qty),
    productCount: num(row.product_count),
    needsReviewCount: num(row.needs_review_count),
    byStore: parseByStore(row.by_store),
    movement: movements.get(String(row.snapshot_date)) ?? null,
  }));
}

function parseByStore(value: unknown): Record<string, StoreTotals> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, StoreTotals> = {};
  for (const [store, raw] of Object.entries(value as Record<string, Record<string, unknown>>)) {
    out[store] = { v: num(raw?.v), q: num(raw?.q), n: num(raw?.n) };
  }
  return out;
}

/** 店舗名の並び順：金額の大きい順。「複数」「未設定」は最後 */
export function sortStores(names: Iterable<string>, valueOf: (store: string) => number): string[] {
  const rank = (store: string) => (store === UNSET_STORE ? 2 : store === MULTI_STORE ? 1 : 0);
  return [...new Set(names)].sort((a, b) => rank(a) - rank(b) || valueOf(b) - valueOf(a) || a.localeCompare(b, "ja"));
}

export async function fetchSnapshotItems(
  snapshotDate: string,
): Promise<Array<{ c: string; q: number; v: number; s?: string }>> {
  const { data, error } = await client()
    .from("cost_inventory_snapshots")
    .select("items")
    .eq("snapshot_date", snapshotDate)
    .single();
  if (error) throw friendly(error);
  return Array.isArray(data?.items) ? (data.items as Array<{ c: string; q: number; v: number; s?: string }>) : [];
}

export async function fetchLogs(): Promise<LogRow[]> {
  const { data, error } = await client()
    .from("cost_stock_log")
    .select("*")
    .order("id", { ascending: false })
    .limit(500);
  if (error) throw friendly(error);
  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: num(row.id),
    productCode: String(row.product_code ?? ""),
    loggedAt: String(row.logged_at ?? ""),
    event: String(row.event ?? ""),
    shipmentId: (row.shipment_id as string | null) ?? null,
    neStock: numOrNull(row.ne_stock),
    lotsQtyBefore: numOrNull(row.lots_qty_before),
    consumed: num(row.consumed),
    adjusted: num(row.adjusted),
    opening: num(row.opening),
    added: num(row.added),
  }));
}

export type ReconcileResult = {
  ok: true;
  checkedCount: number;
  notFoundCount: number;
  notFoundCodes: string[];
  consumedTotal: number;
  consumedProducts: number;
  adjustedProducts: number;
  openingProducts: number;
  snapshot: { total_value_jpy?: number; snapshot_date?: string } | null;
  offset?: number;
  nextOffset?: number | null;
  totalCodes?: number;
  tagsSaved?: number;
  tagsError?: string | null;
  finishedAt: string;
};

export type ReconcileProgress = { done: number; total: number };

export class NeReauthError extends Error {
  constructor(message: string, public reauthUrl: string) {
    super(message);
  }
}

async function runReconcileChunk(accessToken: string, seedOpening: boolean, offset: number): Promise<ReconcileResult> {
  if (!NE_SYNC_WORKER_URL) throw new Error("NEXT_PUBLIC_NE_SYNC_WORKER_URL が未設定です。");
  let response: Response;
  try {
    response = await fetch(`${NE_SYNC_WORKER_URL}/api/cost/reconcile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ seed_opening: seedOpening, offset }),
    });
  } catch (err) {
    // ブラウザの「Failed to fetch」はワーカーに届かない／CORSヘッダーのない応答（ワーカー内の未処理エラー等）のとき
    throw new Error(
      `ne-sync-worker から応答を受け取れませんでした（${err instanceof Error ? err.message : String(err)}）。` +
        `ワーカーのURL（${NE_SYNC_WORKER_URL}）とデプロイ状態を確認してください。ワーカー側でエラーが起きている場合は \`npx wrangler tail\` で内容が見られます。`,
    );
  }
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // JSONでない応答
  }
  if (!response.ok || payload.ok !== true) {
    const message = String(payload.message ?? payload.error ?? text ?? "照合に失敗しました。").split("\n")[0];
    if (payload.code === "NE_TOKEN_EXPIRED" && typeof payload.reauthUrl === "string") {
      throw new NeReauthError(message, payload.reauthUrl);
    }
    throw new Error(`NE照合に失敗しました（${offset > 0 ? `${offset}件目から・` : ""}${response.status}）: ${message}`);
  }
  return payload as unknown as ReconcileResult;
}

/**
 * NEとの照合。ワーカーは1回の呼び出しで1000件ずつ照合し、続きの位置（nextOffset）を返すので、
 * 最後まで繰り返して結果を合算する（Cloudflare Workers のサブリクエスト上限対策）。
 * 途中で失敗しても、それまでの分は照合済み。もう一度押せば最初から照合し直す（照合は何度やっても同じ結果になる）。
 */
export async function runReconcile(
  accessToken: string,
  seedOpening: boolean,
  onProgress?: (progress: ReconcileProgress) => void,
): Promise<ReconcileResult> {
  let offset: number | null = 0;
  let total: ReconcileResult | null = null;
  for (let round = 0; offset !== null; round += 1) {
    if (round > 200) throw new Error("照合が終わりませんでした（200回を超えました）。");
    const part: ReconcileResult = await runReconcileChunk(accessToken, seedOpening, offset);
    total = total
      ? {
          ...part,
          checkedCount: total.checkedCount + part.checkedCount,
          notFoundCount: total.notFoundCount + part.notFoundCount,
          notFoundCodes: [...total.notFoundCodes, ...part.notFoundCodes].slice(0, 100),
          consumedTotal: total.consumedTotal + part.consumedTotal,
          consumedProducts: total.consumedProducts + part.consumedProducts,
          adjustedProducts: total.adjustedProducts + part.adjustedProducts,
          openingProducts: total.openingProducts + part.openingProducts,
          snapshot: part.snapshot ?? total.snapshot,
          tagsSaved: (total.tagsSaved ?? 0) + (part.tagsSaved ?? 0),
          tagsError: total.tagsError ?? part.tagsError ?? null,
        }
      : part;
    // 古いワーカー（nextOffsetを返さない）なら1回で終わり
    offset = typeof part.nextOffset === "number" ? part.nextOffset : null;
    onProgress?.({ done: total.checkedCount, total: part.totalCodes ?? total.checkedCount });
  }
  return total as ReconcileResult;
}
