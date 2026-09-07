"use client";

const THEME_STORAGE_KEY = "defy-theme:v1";

export default function ThemeToggle({
  className = "",
}: {
  className?: string;
}) {
  function toggleTheme() {
    const root = document.documentElement;
    const nextTheme = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = nextTheme;

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The current-page theme still changes when storage is unavailable.
    }
  }

  return (
    <button
      type="button"
      className={`theme-toggle ${className}`.trim()}
      aria-label="Toggle light and dark mode"
      title="Switch color mode"
      onClick={toggleTheme}
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        <span className="theme-icon-moon">☾</span>
        <span className="theme-icon-sun">☀</span>
      </span>
      <span className="theme-toggle-copy">
        <strong className="theme-copy-light">Night mode</strong>
        <strong className="theme-copy-dark">Light mode</strong>
        <small>Switch appearance</small>
      </span>
      <span className="theme-toggle-switch" aria-hidden="true">
        <i />
      </span>
    </button>
  );
}