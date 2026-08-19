"use client";

import { useEffect, useState } from "react";

type Theme = "dark" | "light";

export default function ThemeToggle() {
  // Session-only: no persistence, resets to dark on reload.
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path
            d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="8" cy="8" r="3.2" fill="currentColor" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path
            d="M13.4 10.4A5.5 5.5 0 1 1 5.6 2.6a6 6 0 0 0 7.8 7.8Z"
            fill="currentColor"
          />
        </svg>
      )}
    </button>
  );
}
