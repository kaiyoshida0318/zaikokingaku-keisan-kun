"use client";

import { ReactNode, useEffect } from "react";

export default function Modal({
  title,
  onClose,
  size,
  children,
}: {
  title: string;
  onClose: () => void;
  size?: "lg";
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`modal ${size === "lg" ? "modal-lg" : ""}`} role="dialog" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="btn-close" onClick={onClose} aria-label="閉じる">×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
