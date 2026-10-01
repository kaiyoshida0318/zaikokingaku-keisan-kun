"use client";

import { FormEvent, useState } from "react";
import { LOGIN_EMAIL, supabase } from "@/lib/supabaseClient";
import BrandMark from "./BrandMark";

// キーを入れるだけで入れるログイン。
// 中身は Supabase Auth の専用ユーザー（NEXT_PUBLIC_ZAIKO_LOGIN_EMAIL）のパスワード認証なので、
// キーはブラウザのコードに含まれず、データの読み取りもSupabaseのRLSで守られる。
// 一度入ればこのブラウザではログイン状態が続く。
export default function LoginPanel() {
  const [key, setKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!supabase) return setError("Supabase設定が未設定です。");
    if (!LOGIN_EMAIL) return setError("NEXT_PUBLIC_ZAIKO_LOGIN_EMAIL が未設定です。");
    if (!key) return setError("キーを入力してください。");

    setSubmitting(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: LOGIN_EMAIL, password: key });
      if (signInError) {
        throw new Error(/invalid login credentials/i.test(signInError.message) ? "キーが違います。" : signInError.message);
      }
      setKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "ログインに失敗しました。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={handleSubmit}>
        <BrandMark />
        <label className="auth-field">
          <span>キー</span>
          <input
            type="password"
            autoComplete="current-password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="キーを入力"
            autoFocus
          />
        </label>
        {error && <p className="auth-error">{error}</p>}
        <button className="button button--primary" type="submit" disabled={submitting}>
          {submitting ? "確認中…" : "開く"}
        </button>
      </form>
    </main>
  );
}
