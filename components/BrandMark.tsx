import { assetPath } from "@/lib/supabaseClient";

export default function BrandMark() {
  return (
    <button type="button" className="brand" aria-label="トップへ" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
      <img src={assetPath("/logo.png")} alt="在庫金額計算くん" />
    </button>
  );
}
