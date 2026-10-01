export default function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand--compact" : ""}`}>
      <span className="brand-icon" aria-hidden="true">
        <svg viewBox="0 0 64 64">
          <path d="M20 14l12 17 12-17M32 31v20M22 35h20M22 43h20" />
        </svg>
      </span>
      <span className="brand-name">在庫金額計算くん</span>
    </div>
  );
}
