"use client";

export default function Spinner({
  size = 16,
  label,
}: {
  size?: number;
  label?: string;
}) {
  return (
    <span
      className="jt-spinner-wrap"
      style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block" }}>
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="42 100"
          opacity={0.9}
        >
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.8s"
            repeatCount="indefinite"
          />
        </circle>
      </svg>
      {label && <span className="jt-spinner-label">{label}</span>}
    </span>
  );
}
