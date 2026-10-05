"use client";

import { FormEvent, useState } from "react";
import { type CostRounding, unitYen } from "@/lib/format";
import { LOGIN_EMAIL, supabase, supabaseUrl } from "@/lib/supabaseClient";
import Modal from "./Modal";

// 設定：キーの入力（＝専用ユーザーのパスワード認証）。
// キーはブラウザのコードに含まれず、Supabase だけが知っている。
// 正しいキーを入れるとこのブラウザではログインが続き、データが表示される。
const roundingDigits: Array<[CostRounding["digits"], string]> = [
  [0, "整数"],
  [1, "小数1桁"],
  [2, "小数2桁"],
];
const roundingModes: Array<[CostRounding["mode"], string]> = [
  ["round", "四捨五入"],
  ["floor", "切り捨て"],
  ["ceil", "切り上げ"],
];
// 丸めの例に使う原価
const ROUNDING_SAMPLES = [472.55, 84.333];

export default function SettingsPanel({
  isUnlocked,
  onLock,
  onClose,
  rounding,
  onRoundingChange,
}: {
  isUnlocked: boolean;
  onLock: () => void;
  onClose: () => void;
  rounding: CostRounding;
  onRoundingChange: (next: CostRounding) => void;
}) {
  const [key, setKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!supabase) return setError("Supabaseが未設定です（NEXT_PUBLIC_SUPABASE_URL / ANON_KEY）。");
    if (!LOGIN_EMAIL) return setError("NEXT_PUBLIC_ZAIKO_LOGIN_EMAIL が未設定です。");
    if (!key) return setError("キーを入力してください。");

    setSubmitting(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: LOGIN_EMAIL, password: key });
      if (signInError) {
        throw new Error(/invalid login credentials/i.test(signInError.message) ? "キーが違います。" : signInError.message);
      }
      setKey("");
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "確認に失敗しました。";
      setError(
        /failed to fetch|load failed|networkerror/i.test(message)
          ? `Supabase（${supabaseUrl || "未設定"}）に接続できませんでした。NEXT_PUBLIC_SUPABASE_URL を確認してください。`
          : message,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="⚙ 設定" onClose={onClose}>
      <div className="settings-menu">
        <div className="settings-item settings-item--static">
          <b>🔑 キー</b>
          {isUnlocked ? (
            <>
              <small>入力済みです。このブラウザではデータを表示できます。</small>
              <div className="settings-actions">
                <span className="status success">表示中</span>
                <button type="button" className="btn-secondary" onClick={onLock}>キーを外す</button>
              </div>
            </>
          ) : (
            <form onSubmit={handleSubmit}>
              <small>正しいキーを入れるとデータが表示されます。一度入れればこのブラウザでは保持されます。</small>
              <div className="settings-key-row">
                <input
                  type="password"
                  autoComplete="current-password"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder="キーを入力"
                  autoFocus
                />
                <button className="btn-primary" type="submit" disabled={submitting}>
                  {submitting ? "確認中…" : "保存"}
                </button>
              </div>
              {error && <p className="form-error">{error}</p>}
            </form>
          )}
        </div>
        <div className="settings-item settings-item--static">
          <b>🔢 原価の小数点</b>
          <small>
            平均原価・便の原価など、単価の表示とCSVでの丸め方です。在庫金額は丸める前の原価で計算します。
            設定はこのブラウザに保存されます。
          </small>
          <div className="settings-rounding">
            <div className="seg" role="group" aria-label="桁数">
              {roundingDigits.map(([digits, label]) => (
                <button
                  key={digits}
                  type="button"
                  className={rounding.digits === digits ? "active" : ""}
                  onClick={() => onRoundingChange({ ...rounding, digits })}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="丸め方">
              {roundingModes.map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={rounding.mode === mode ? "active" : ""}
                  onClick={() => onRoundingChange({ ...rounding, mode })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <small className="settings-example">
            例：{ROUNDING_SAMPLES.map((v) => `¥${v} → ${unitYen(v, rounding)}`).join("　")}
          </small>
        </div>
        <div className="settings-item settings-item--static">
          <b>🔌 接続先</b>
          <small>Supabase：{supabaseUrl ? new URL(supabaseUrl).host : "未設定"}</small>
        </div>
      </div>
    </Modal>
  );
}
