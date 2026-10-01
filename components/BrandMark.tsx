import { assetPath } from "@/lib/supabaseClient";

// ロゴ（ライト/ダークで出し分け。切り替えは globals.css の data-theme で行う）
export default function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <h1 className={`brand ${compact ? "brand--compact" : ""}`}>
      <img className="brand-logo brand-logo--light" src={assetPath("/logo.png")} alt="在庫金額計算くん" />
      <img className="brand-logo brand-logo--dark" src={assetPath("/logo-dark.png")} alt="" aria-hidden="true" />
    </h1>
  );
}
