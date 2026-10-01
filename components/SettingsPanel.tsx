"use client";

import { FormEvent, useState } from "react";
import { LOGIN_EMAIL, supabase, supabaseUrl } from "@/lib/supabaseClient";
import Modal from "./Modal";

// 設定：キーの入力（＝専用ユーザーのパスワード認証）。
// キーはブラウザのコードに含まれず、Supabase だけが知っている。
// 正しいキーを入れるとこのブラウザではログインが続き、データが表示される。
export default function SettingsPanel({
  isUnlocked,
  onLock,
  onClose,
}: {
  isUnlocked: boolean;
  onLock: () => void;
  onClose: () => void;
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
          <b>🔌 接続先</b>
          <small>Supabase：{supabaseUrl ? new URL(supabaseUrl).host : "未設定"}</small>
        </div>
      </div>
    </Modal>
  );
}
