"use client";

import type { ReconcileResult } from "@/lib/data";
import { count, dateTime, yen } from "@/lib/format";
import Modal from "./Modal";

// 照合と更新。「更新」だけだと、画面を読み直すのかNEと照合するのか分からないため、
// 押すと何が起きるか、どの数字がいつ変わるかを1か所にまとめる。
export default function SyncModal(props: {
  onClose: () => void;
  locked: boolean;
  totalValue: number | null;
  lastCheckAt: string | null;
  lastCheckSource: string | null;
  loadedAt: string | null;
  loading: boolean;
  onReload: () => void;
  seedOpening: boolean;
  onSeedOpeningChange: (value: boolean) => void;
  reconciling: boolean;
  onReconcile: () => void;
  reconcileResult: ReconcileResult | null;
  reconcileError: string | null;
  reauthUrl: string | null;
  workerConfigured: boolean;
}) {
  return (
    <Modal title="🔄 照合と更新" size="lg" onClose={props.onClose}>
      <div className="refresh-summary">
        <div><span>在庫金額</span><b>{props.totalValue === null ? "—" : yen(props.totalValue)}</b></div>
        <div>
          <span>最終照合</span>
          <b>{props.lastCheckAt ? `${dateTime(props.lastCheckAt)}（${props.lastCheckSource === "cron" ? "自動" : "手動"}）` : "—"}</b>
        </div>
        <div><span>この画面の最終更新</span><b>{props.loadedAt ? dateTime(props.loadedAt) : "—"}</b></div>
      </div>

      <div className={`refresh-action is-primary ${props.locked ? "is-disabled" : ""}`}>
        <span className="refresh-action-icon">⇄</span>
        <span className="refresh-action-body">
          <span className="refresh-action-title">NEと照合する</span>
          <span className="refresh-action-desc">
            NEの在庫数と比べて、減った分を<b>古い便から消費</b>し、今日の在庫金額を「日ごとの記録」に保存します。毎日 03:20 にも自動で実行されます。
          </span>
          <label className="check">
            <input
              type="checkbox"
              checked={props.seedOpening}
              onChange={(event) => props.onSeedOpeningChange(event.target.checked)}
              disabled={props.locked}
            />
            便のない商品も期首在庫として登録する（初回のみ。商品DBの全商品をNEの在庫数・原価で登録）
          </label>
          {props.reconcileError && (
            <span className="form-error">
              {props.reconcileError}
              {props.reauthUrl && (
                <>
                  {" "}
                  <a href={props.reauthUrl} target="_blank" rel="noreferrer">NE認証をやり直す</a>
                </>
              )}
            </span>
          )}
          {props.reconcileResult && !props.reconcileError && (
            <span className="form-ok">
              {count(props.reconcileResult.checkedCount)}商品を照合
              {props.reconcileResult.consumedTotal > 0 && `／古い便から${count(props.reconcileResult.consumedTotal)}個消費`}
              {props.reconcileResult.openingProducts > 0 && `／期首在庫 ${count(props.reconcileResult.openingProducts)}商品`}
              {props.reconcileResult.adjustedProducts > 0 && `／在庫増の調整 ${count(props.reconcileResult.adjustedProducts)}商品`}
              {props.reconcileResult.notFoundCount > 0 && `／NEにない商品 ${count(props.reconcileResult.notFoundCount)}件`}
            </span>
          )}
        </span>
        <button
          type="button"
          className="btn-primary"
          onClick={props.onReconcile}
          disabled={props.locked || props.reconciling || !props.workerConfigured}
        >
          {props.reconciling ? "照合中…" : "照合する"}
        </button>
      </div>

      <div className={`refresh-action ${props.locked ? "is-disabled" : ""}`}>
        <span className="refresh-action-icon">↻</span>
        <span className="refresh-action-body">
          <span className="refresh-action-title">画面を更新する</span>
          <span className="refresh-action-desc">
            Supabaseに保存されている内容を読み直すだけです。<b>NEは見に行きません。</b>
          </span>
        </span>
        <button type="button" className="btn-secondary" onClick={props.onReload} disabled={props.locked || props.loading}>
          {props.loading ? "読み込み中…" : "更新"}
        </button>
      </div>

      {props.locked && <p className="form-error">キーを入力すると操作できます（⚙ 設定）。</p>}
      {!props.workerConfigured && <p className="form-error">NEXT_PUBLIC_NE_SYNC_WORKER_URL が未設定です。</p>}

      <h3 className="refresh-section">何が・いつ反映されるか</h3>
      <div className="refresh-table-wrap">
        <table className="refresh-table">
          <thead>
            <tr><th>項目</th><th className="when">いつ変わるか</th><th>補足</th></tr>
          </thead>
          <tbody>
            <tr className="group"><td colSpan={3}>入庫一括が入れるもの</td></tr>
            <tr>
              <td>便と1単位原価</td>
              <td><span className="tag tag-btn">入庫一括のNE更新</span></td>
              <td>配送依頼書ごとに、単価・オプション・中国内運賃・国際送料から計算した原価で登録されます。同時にNEの原価も最新の便の値に更新されます。</td>
            </tr>
            <tr>
              <td>過去の便（原価だけ）</td>
              <td><span className="tag tag-hand">入庫一括で「原価だけ登録」</span></td>
              <td>届いている便を、登録日＝配送依頼書の日付で登録し、今のNE在庫と照合します。NEの在庫数は変わりません。</td>
            </tr>
            <tr>
              <td>入数・共有資材の割当</td>
              <td><span className="tag tag-hand">入庫一括で手入力</span></td>
              <td>1行に複数コードがある行や、商品コードのない紙などの分け方。一度入れれば次回から自動です。</td>
            </tr>
            <tr className="group"><td colSpan={3}>照合で変わるもの</td></tr>
            <tr>
              <td>各便の残り（古い便から消費）</td>
              <td><span className="tag tag-auto">毎日 3:20</span><span className="tag tag-btn">NEと照合する</span></td>
              <td>NEの在庫数が便の残りより少なければ、その差を古い便から減らします。多いとき（返品・棚卸増など）は「在庫増の調整」として最新の原価で足します。</td>
            </tr>
            <tr>
              <td>日ごとの記録</td>
              <td><span className="tag tag-auto">毎日 3:20</span><span className="tag tag-btn">NEと照合する</span></td>
              <td>1日1件。同じ日に何度照合しても最後の結果で上書きされます。月末の棚卸金額の控えに使えます。</td>
            </tr>
            <tr>
              <td>期首在庫</td>
              <td><span className="tag tag-btn">初回の照合でチェック</span></td>
              <td>便がまだない商品を、NEの在庫数・原価で仮に登録します。その商品で最初に原価計算された便が入ると、期首在庫の原価はその便の原価に置き換わります。</td>
            </tr>
            <tr className="group"><td colSpan={3}>この画面</td></tr>
            <tr>
              <td>表示している数字</td>
              <td><span className="tag tag-auto">開いたとき</span><span className="tag tag-btn">画面を更新する</span></td>
              <td>Supabaseの内容を読み直すだけです。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
