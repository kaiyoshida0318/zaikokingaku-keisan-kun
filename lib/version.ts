/** このアプリのバージョン（package.json の version。ビルド時に埋め込まれる） */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
/** ビルドした日時（ISO）。開発中は空 */
export const APP_BUILT_AT = process.env.NEXT_PUBLIC_APP_BUILT_AT ?? "";
/** GitHub Actions でビルドしたときのコミット番号（7桁）。それ以外は空 */
export const APP_COMMIT = process.env.NEXT_PUBLIC_APP_COMMIT ?? "";

export type PublishedVersion = { version: string; builtAt: string; commit: string };

/**
 * 公開中の version.json を読む（キャッシュを使わない）。
 * 開いている画面より新しいバージョンが公開されていれば、それを返す。読めない・同じなら null。
 */
export async function fetchNewerVersion(): Promise<PublishedVersion | null> {
  if (process.env.NODE_ENV !== "production") return null;
  try {
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    const res = await fetch(`${base}/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const published = (await res.json()) as Partial<PublishedVersion>;
    if (!published.version) return null;
    return published.version !== APP_VERSION
      ? { version: published.version, builtAt: published.builtAt ?? "", commit: published.commit ?? "" }
      : null;
  } catch {
    return null;
  }
}
