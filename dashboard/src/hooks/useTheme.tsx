// Theme: dark default, `.light` on <html> for light. Persisted in
// localStorage; the no-flash script in index.html applies it pre-paint.

import { useCallback, useEffect, useState } from "react";

type Theme = "dark" | "light";

function current(): Theme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(current);

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    try {
      localStorage.setItem("theme", theme);
    } catch {}
  }, [theme]);

  const toggleTheme = useCallback(() => {
    // Add a scoped transition class for ~300ms so the whole page eases
    // between palettes instead of snapping. Removed right after so nothing
    // else in the app stays saddled with a global `transition: all`.
    document.body.classList.add("theme-transition");
    window.setTimeout(() => document.body.classList.remove("theme-transition"), 300);
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  return { theme, toggleTheme };
}
