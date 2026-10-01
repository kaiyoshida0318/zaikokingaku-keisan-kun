"use client";

import { FormEvent, useEffect, useState } from "react";
import { AUTH_API_BASE_URL, supabase } from "@/lib/supabaseClient";
import BrandMark from "./BrandMark";

type QuestionResponse = { ok?: boolean; question?: string; displayName?: string };
type LoginResponse = {
  ok?: boolean;
  error?: string;
  session?: { access_token?: string; refresh_token?: string };
};

// 入庫一括と同じ「秘密の質問ログイン」（認証APIがSupabaseのセッションを発行する）
export default function LoginPanel() {
  const [answer, setAnswer] = useState("");
  const [question, setQuestion] = useState("秘密の質問");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!AUTH_API_BASE_URL) return;
    fetch(`${AUTH_API_BASE_URL}/api/auth/question`, { cache: "no-store" })
      .then((res) => res.json().then((payload: QuestionResponse) => ({ res, payload })))
      .then(({ res, payload }) => {
        if (alive && res.ok && payload.ok) setQuestion(payload.question || "秘密の質問");
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!supabase) return setError("Supabase設定が未設定です。");
    if (!AUTH_API_BASE_URL) return setError("ログインAPIが未設定です。NEXT_PUBLIC_AUTH_API_BASE_URLを設定してください。");
    if (!answer.trim()) return setError("回答を入力してください。");

    setSubmitting(true);
    try {
      const res = await fetch(`${AUTH_API_BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: answer.trim() }),
      });
      const payload = (await res.json().catch(() => ({}))) as LoginResponse;
      if (!res.ok || !payload.ok || !payload.session?.access_token || !payload.session.refresh_token) {
        throw new Error(payload.error || "ログインに失敗しました。");
      }
      const { error: sessionError } = await supabase.auth.setSession({
        access_token: payload.session.access_token,
        refresh_token: payload.session.refresh_token,
      });
      if (sessionError) throw sessionError;
      setAnswer("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "ログインに失敗しました。";
      setError(message === "Failed to fetch" ? "ログインAPIに接続できませんでした。" : message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={handleSubmit}>
        <BrandMark />
        <label className="auth-field">
          <span>{question}</span>
          <input
            type="password"
            autoComplete="current-password"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="回答"
            autoFocus
          />
        </label>
        {error && <p className="auth-error">{error}</p>}
        <button className="button button--primary" type="submit" disabled={submitting}>
          {submitting ? "ログイン中…" : "ログイン"}
        </button>
      </form>
    </main>
  );
}
