"use client";

import { FormEvent, useState } from "react";
import { LOGIN_EMAIL, supabase, supabaseUrl } from "@/lib/supabaseClient";

type Theme = "light" | "dark";

// 設定パネル：キーの入力（＝専用ユーザーのパスワード認証）と表示テーマ。
// キーはブラウザのコードに含まれず、Supabase だけが知っている。
// 正しいキーを入れるとこのブラウザではログインが続き、データが表示される。
export default function SettingsPanel({
  isUnlocked,
  theme,
  onChangeTheme,
  onLock,
  onClose,
}: {
  isUnlocked: boolean;
  theme: Theme | null;
  onChangeTheme: (theme: Theme) => void;
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
    <div className="settings" role="dialog" aria-label="設定">
      <div className="settings-head">
        <h2>設定</h2>
        <button type="button" className="settings-close" onClick={onClose} aria-label="閉じる">×</button>
      </div>

      <section className="settings-section">
        <h3>キー</h3>
        {isUnlocked ? (
          <div className="settings-unlocked">
            <p><span className="dot dot--on" />キー入力済み。このブラウザではデータを表示できます。</p>
            <button type="button" className="button" onClick={onLock}>キーを外す</button>
          </div>
        ) : (
          <form className="settings-form" onSubmit={handleSubmit}>
            <p className="settings-note">正しいキーを入れるとデータが表示されます。一度入れればこのブラウザでは保持されます。</p>
            <div className="settings-row">
              <input
                type="password"
                autoComplete="current-password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="キーを入力"
                autoFocus
              />
              <button className="button button--primary" type="submit" disabled={submitting}>
                {submitting ? "確認中…" : "保存"}
              </button>
            </div>
            {error && <p className="settings-error">{error}</p>}
          </form>
        )}
      </section>

      <section className="settings-section">
        <h3>表示</h3>
        <div className="segmented" role="group" aria-label="テーマ">
          <button type="button" className={theme === "light" ? "is-active" : ""} onClick={() => onChangeTheme("light")}>ライト</button>
          <button type="button" className={theme === "dark" ? "is-active" : ""} onClick={() => onChangeTheme("dark")}>ダーク</button>
        </div>
      </section>

      <p className="settings-meta">接続先 {supabaseUrl ? new URL(supabaseUrl).host : "未設定"}</p>
    </div>
  );
}
