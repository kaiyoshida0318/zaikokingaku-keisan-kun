import { readFileSync, writeFileSync } from "node:fs";
import { PHASE_PRODUCTION_BUILD } from "next/constants.js";

const isProd = process.env.NODE_ENV === "production";
const basePath = isProd ? "/zaikokingaku-keisan-kun" : "";

// バージョンは package.json の "version"。更新を渡すたびに上げる（画面のヘッダーに出る）
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
// ビルドした日時。ビルド中に設定が何度読まれても同じ値になるよう、最初に決めた値を引き継ぐ
process.env.APP_BUILT_AT ||= new Date().toISOString();
const builtAt = process.env.APP_BUILT_AT;
// GitHub Actions でビルドしたときはコミット番号も出す
const commit = (process.env.GITHUB_SHA ?? "").slice(0, 7);

/** @type {(phase: string) => import('next').NextConfig} */
export default function nextConfig(phase) {
  if (phase === PHASE_PRODUCTION_BUILD) {
    // 公開中のバージョン（画面が古いままか確かめるのに使う）。public に置くと out/version.json になる
    writeFileSync(
      new URL("./public/version.json", import.meta.url),
      `${JSON.stringify({ version, builtAt, commit }, null, 2)}\n`,
    );
  }
  return {
    output: "export",
    trailingSlash: true,
    basePath,
    assetPrefix: isProd ? "/zaikokingaku-keisan-kun/" : "",
    images: {
      unoptimized: true,
    },
    env: {
      NEXT_PUBLIC_APP_VERSION: version,
      NEXT_PUBLIC_APP_BUILT_AT: builtAt,
      NEXT_PUBLIC_APP_COMMIT: commit,
      NEXT_PUBLIC_BASE_PATH: basePath,
    },
  };
}
