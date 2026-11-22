import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextType {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  systemTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const THEME_STORAGE_KEY = "facetube-theme";
export const DEFAULT_THEME: Theme = "dark";
export const DARK_THEME_COLOR = "#0b0c11";
export const LIGHT_THEME_COLOR = "#ffffff";

/**
 * Synchronous pre-hydration script injected in __root.tsx <head>.
 * Guarantees:
 * 1. Missing or invalid `facetube-theme` defaults to 'dark' regardless of OS setting.
 * 2. Saved 'light', 'dark', or 'system' preferences are honored immediately before first paint.
 * 3. Saved localStorage values are never overwritten during initialization.
 * 4. Storage access errors safely default back to Dark Theme.
 */
export const PRE_HYDRATION_THEME_SCRIPT = `(function(){try{var k='${THEME_STORAGE_KEY}';var s=null;try{s=window.localStorage.getItem(k);}catch(e){}var t=(s==='light'||s==='dark'||s==='system')?s:'${DEFAULT_THEME}';var m=false;try{m=typeof window.matchMedia==='function'&&window.matchMedia('(prefers-color-scheme: dark)').matches;}catch(e){}var d=t==='dark'||(t==='system'&&m);var r=document.documentElement;if(d){r.classList.add('dark');r.style.colorScheme='dark';}else{r.classList.remove('dark');r.style.colorScheme='light';}var meta=document.querySelector('meta[name="theme-color"]');if(meta){meta.setAttribute('content',d?'${DARK_THEME_COLOR}':'${LIGHT_THEME_COLOR}');}}catch(e){try{document.documentElement.classList.add('dark');document.documentElement.style.colorScheme='dark';}catch(_e){}}})();`;

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// eslint-disable-next-line react-refresh/only-export-components
export function normalizeThemePreference(raw: unknown): Theme {
  if (raw === "light" || raw === "dark" || raw === "system") {
    return raw;
  }
  return DEFAULT_THEME;
}

// eslint-disable-next-line react-refresh/only-export-components
export function resolveThemeMode(theme: Theme, systemTheme: ResolvedTheme): ResolvedTheme {
  return theme === "system" ? systemTheme : theme;
}

// eslint-disable-next-line react-refresh/only-export-components
export function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "dark";
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function getStoredTheme(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return normalizeThemePreference(stored);
  } catch {
    // localStorage might be unavailable
    return DEFAULT_THEME;
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function applyThemeToDocument(
  resolvedTheme: ResolvedTheme,
  doc: Document | undefined = typeof document !== "undefined" ? document : undefined,
): void {
  if (!doc) return;
  const root = doc.documentElement;
  const isDark = resolvedTheme === "dark";

  if (isDark) {
    root.classList.add("dark");
    root.style.colorScheme = "dark";
  } else {
    root.classList.remove("dark");
    root.style.colorScheme = "light";
  }

  const themeColorMeta = doc.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) {
    themeColorMeta.setAttribute("content", isDark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Always initialize with deterministic SSR defaults ("dark") so initial client hydration matches
  // the server HTML (`<html className="dark">`) without mismatches.
  // Any explicitly saved preference ("light", "dark", or "system") is synced in useEffect without
  // overwriting localStorage or flickering over the pre-hydration <script> class.
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>("dark");
  const [hasSyncedStoredTheme, setHasSyncedStoredTheme] = useState(false);

  useEffect(() => {
    const stored = getStoredTheme();
    const detectedSystem = getSystemTheme();
    setThemeState(stored);
    setSystemTheme(detectedSystem);
    setHasSyncedStoredTheme(true);
  }, []);

  // Calculate the currently resolved theme
  const resolvedTheme: ResolvedTheme = useMemo(
    () => resolveThemeMode(theme, systemTheme),
    [theme, systemTheme],
  );

  // Listen to OS system theme changes
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      const isDark = e.matches;
      setSystemTheme(isDark ? "dark" : "light");
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    } else if (mediaQuery.addListener) {
      // Fallback for older browsers
      mediaQuery.addListener(handleChange);
      return () => mediaQuery.removeListener(handleChange);
    }
    return undefined;
  }, []);

  // Synchronize DOM classes, colorScheme, and theme-color only after stored preference is synced
  // so an existing Light or System preference applied by the pre-hydration script never flickers.
  useEffect(() => {
    if (!hasSyncedStoredTheme) return;
    applyThemeToDocument(resolvedTheme);
  }, [hasSyncedStoredTheme, resolvedTheme]);

  const setTheme = useCallback((newTheme: Theme) => {
    const normalized = normalizeThemePreference(newTheme);
    setThemeState(normalized);
    setHasSyncedStoredTheme(true);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, normalized);
    } catch {
      // ignore storage errors
    }
  }, []);

  // Quick toggle cycles through dark -> light -> system -> dark
  const toggleTheme = useCallback(() => {
    setHasSyncedStoredTheme(true);
    setThemeState((prev) => {
      let next: Theme;
      if (prev === "dark") {
        next = "light";
      } else if (prev === "light") {
        next = "system";
      } else {
        next = "dark";
      }
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      systemTheme,
      setTheme,
      toggleTheme,
    }),
    [theme, resolvedTheme, systemTheme, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
