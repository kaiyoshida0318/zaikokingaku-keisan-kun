import { createClient } from "@supabase/supabase-js";

export const ZAIKO_AUTH_STORAGE_KEY = "zaiko-kingaku-supabase-auth-token";

function normalizeSupabaseProjectUrl(input: string | undefined): string {
  const trimmed = (input ?? "").trim().replace(/^['"]|['"]$/g, "").replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

const supabaseUrl = normalizeSupabaseProjectUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
const supabaseAnonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim().replace(/^['"]|['"]$/g, "");

export const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          storageKey: ZAIKO_AUTH_STORAGE_KEY,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      })
    : null;

export function getSupabaseConfigError(): string | null {
  if (supabase) return null;
  return "NEXT_PUBLIC_SUPABASE_URL と NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してからビルドしてください。";
}

export const AUTH_API_BASE_URL = String(process.env.NEXT_PUBLIC_AUTH_API_BASE_URL ?? "").replace(/\/+$/, "");
export const NE_SYNC_WORKER_URL = String(process.env.NEXT_PUBLIC_NE_SYNC_WORKER_URL ?? "").trim().replace(/\/+$/, "");
