import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import {
  THEME_STORAGE_KEY,
  DEFAULT_THEME,
  DARK_THEME_COLOR,
  LIGHT_THEME_COLOR,
  PRE_HYDRATION_THEME_SCRIPT,
  normalizeThemePreference,
  resolveThemeMode,
  getStoredTheme,
  getSystemTheme,
  applyThemeToDocument,
} from "../lib/theme-context.tsx";

interface MockEnvOptions {
  storedValue?: string | null;
  throwOnStorage?: boolean;
  osDark?: boolean;
  initialHasDarkClass?: boolean;
}

function createMockBrowserEnvironment(opts: MockEnvOptions = {}) {
  const storageMap = new Map<string, string>();
  if (opts.storedValue !== undefined && opts.storedValue !== null) {
    storageMap.set(THEME_STORAGE_KEY, opts.storedValue);
  }
  const setItemCalls: Array<{ key: string; value: string }> = [];

  const classSet = new Set<string>(opts.initialHasDarkClass ? ["dark"] : []);
  const htmlStyle: { colorScheme?: string } = {};
  const metaAttributes = new Map<string, string>([["content", DARK_THEME_COLOR]]);

  const mockMeta = {
    getAttribute(name: string) {
      return metaAttributes.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      metaAttributes.set(name, value);
    },
  };

  const mockDocument = {
    documentElement: {
      classList: {
        add(cls: string) {
          classSet.add(cls);
        },
        remove(cls: string) {
          classSet.delete(cls);
        },
        contains(cls: string) {
          return classSet.has(cls);
        },
      },
      style: htmlStyle,
    },
    querySelector(selector: string) {
      if (selector === 'meta[name="theme-color"]') {
        return mockMeta;
      }
      return null;
    },
  };

  const mockLocalStorage = {
    getItem(key: string) {
      if (opts.throwOnStorage) {
        throw new Error("SecurityError: localStorage unavailable");
      }
      return storageMap.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (opts.throwOnStorage) {
        throw new Error("SecurityError: localStorage unavailable");
      }
      setItemCalls.push({ key, value });
      storageMap.set(key, value);
    },
  };

  const mockWindow = {
    localStorage: mockLocalStorage,
    matchMedia(query: string) {
      return {
        matches: query === "(prefers-color-scheme: dark)" ? Boolean(opts.osDark) : false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      };
    },
  };

  return {
    mockWindow,
    mockDocument,
    storageMap,
    setItemCalls,
    classSet,
    htmlStyle,
    metaAttributes,
  };
}

function runPreHydrationScript(opts: MockEnvOptions = {}) {
  const env = createMockBrowserEnvironment({ initialHasDarkClass: true, ...opts });
  const context = vm.createContext({
    window: env.mockWindow,
    document: env.mockDocument,
  });
  vm.runInContext(PRE_HYDRATION_THEME_SCRIPT, context);
  return env;
}

describe("FaceTube Task 11: Default Dark Theme Initialization, Preservation & SSR Safety", () => {
  const origWindow = (globalThis as Record<string, unknown>)["window"];
  const origDocument = (globalThis as Record<string, unknown>)["document"];

  afterEach(() => {
    if (origWindow === undefined) {
      delete (globalThis as Record<string, unknown>)["window"];
    } else {
      (globalThis as Record<string, unknown>)["window"] = origWindow;
    }
    if (origDocument === undefined) {
      delete (globalThis as Record<string, unknown>)["document"];
    } else {
      (globalThis as Record<string, unknown>)["document"] = origDocument;
    }
  });

  it("1. New visitor defaults to Dark Theme even when OS uses Light mode", () => {
    const pre = runPreHydrationScript({ storedValue: null, osDark: false });
    assert.equal(pre.classSet.has("dark"), true);
    assert.equal(pre.htmlStyle.colorScheme, "dark");
    assert.equal(pre.metaAttributes.get("content"), DARK_THEME_COLOR);
    assert.equal(pre.setItemCalls.length, 0);

    (globalThis as Record<string, unknown>)["window"] = pre.mockWindow;
    const stored = getStoredTheme();
    const system = getSystemTheme();
    assert.equal(DEFAULT_THEME, "dark");
    assert.equal(stored, "dark");
    assert.equal(system, "light");
    assert.equal(resolveThemeMode(stored, system), "dark");
  });

  it("2. Existing user with saved 'light' preference stays in Light Theme (even on Dark OS)", () => {
    const pre = runPreHydrationScript({ storedValue: "light", osDark: true });
    assert.equal(pre.classSet.has("dark"), false);
    assert.equal(pre.htmlStyle.colorScheme, "light");
    assert.equal(pre.metaAttributes.get("content"), LIGHT_THEME_COLOR);
    assert.equal(pre.setItemCalls.length, 0);

    (globalThis as Record<string, unknown>)["window"] = pre.mockWindow;
    const stored = getStoredTheme();
    assert.equal(stored, "light");
    assert.equal(resolveThemeMode(stored, "dark"), "light");
  });

  it("3. Existing user with saved 'dark' preference stays in Dark Theme", () => {
    const pre = runPreHydrationScript({ storedValue: "dark", osDark: false });
    assert.equal(pre.classSet.has("dark"), true);
    assert.equal(pre.htmlStyle.colorScheme, "dark");
    assert.equal(pre.metaAttributes.get("content"), DARK_THEME_COLOR);
    assert.equal(pre.setItemCalls.length, 0);

    (globalThis as Record<string, unknown>)["window"] = pre.mockWindow;
    const stored = getStoredTheme();
    assert.equal(stored, "dark");
    assert.equal(resolveThemeMode(stored, "light"), "dark");
  });

  it("4. Existing user with saved 'system' preference remains 'system' and tracks OS preference", () => {
    const preLightOs = runPreHydrationScript({ storedValue: "system", osDark: false });
    assert.equal(preLightOs.classSet.has("dark"), false);
    assert.equal(preLightOs.htmlStyle.colorScheme, "light");
    assert.equal(preLightOs.metaAttributes.get("content"), LIGHT_THEME_COLOR);
    assert.equal(preLightOs.setItemCalls.length, 0);

    const preDarkOs = runPreHydrationScript({ storedValue: "system", osDark: true });
    assert.equal(preDarkOs.classSet.has("dark"), true);
    assert.equal(preDarkOs.htmlStyle.colorScheme, "dark");
    assert.equal(preDarkOs.metaAttributes.get("content"), DARK_THEME_COLOR);
    assert.equal(preDarkOs.setItemCalls.length, 0);

    (globalThis as Record<string, unknown>)["window"] = preLightOs.mockWindow;
    assert.equal(getStoredTheme(), "system");
    assert.equal(resolveThemeMode("system", "light"), "light");
    assert.equal(resolveThemeMode("system", "dark"), "dark");
  });

  it("5. Invalid, empty, or throwing localStorage safely falls back to Dark Theme", () => {
    for (const invalidVal of ["", "sepia", "LIGHT", "auto", "undefined"]) {
      const pre = runPreHydrationScript({ storedValue: invalidVal, osDark: false });
      assert.equal(pre.classSet.has("dark"), true, `Failed for value "${invalidVal}"`);
      assert.equal(pre.htmlStyle.colorScheme, "dark");
      assert.equal(pre.metaAttributes.get("content"), DARK_THEME_COLOR);
      assert.equal(normalizeThemePreference(invalidVal), "dark");
    }

    const throwingEnv = runPreHydrationScript({ throwOnStorage: true, osDark: false });
    assert.equal(throwingEnv.classSet.has("dark"), true);
    assert.equal(throwingEnv.htmlStyle.colorScheme, "dark");

    (globalThis as Record<string, unknown>)["window"] = throwingEnv.mockWindow;
    assert.equal(getStoredTheme(), "dark");
  });

  it("6. Theme initialization never overwrites saved preferences and updates DOM meta safely", () => {
    for (const saved of ["light", "dark", "system"] as const) {
      const env = runPreHydrationScript({ storedValue: saved, osDark: false });
      (globalThis as Record<string, unknown>)["window"] = env.mockWindow;
      assert.equal(getStoredTheme(), saved);
      assert.equal(env.storageMap.get(THEME_STORAGE_KEY), saved);
      assert.equal(env.setItemCalls.length, 0);
    }

    const docEnv = createMockBrowserEnvironment({ initialHasDarkClass: true });
    applyThemeToDocument("light", docEnv.mockDocument as unknown as Document);
    assert.equal(docEnv.classSet.has("dark"), false);
    assert.equal(docEnv.htmlStyle.colorScheme, "light");
    assert.equal(docEnv.metaAttributes.get("content"), LIGHT_THEME_COLOR);

    applyThemeToDocument("dark", docEnv.mockDocument as unknown as Document);
    assert.equal(docEnv.classSet.has("dark"), true);
    assert.equal(docEnv.htmlStyle.colorScheme, "dark");
    assert.equal(docEnv.metaAttributes.get("content"), DARK_THEME_COLOR);
  });

  it("7. SSR shell renders dark html by default, guards post-hydration flicker, and preserves toggle UI", async () => {
    const rootSource = await fs.readFile(
      path.resolve(process.cwd(), "src/routes/__root.tsx"),
      "utf8",
    );
    const themeContextSource = await fs.readFile(
      path.resolve(process.cwd(), "src/lib/theme-context.tsx"),
      "utf8",
    );
    const toggleSource = await fs.readFile(
      path.resolve(process.cwd(), "src/components/videohub/ThemeToggle.tsx"),
      "utf8",
    );

    // SSR html element starts with className="dark", colorScheme="dark", and suppressHydrationWarning
    assert.ok(
      rootSource.includes(
        '<html lang="en" className="dark" style={{ colorScheme: "dark" }} suppressHydrationWarning>',
      ),
    );
    assert.ok(rootSource.includes("PRE_HYDRATION_THEME_SCRIPT"));
    assert.ok(rootSource.includes('{ name: "theme-color", content: DARK_THEME_COLOR }'));
    assert.equal(
      rootSource.includes(
        '{ name: "theme-color", media: "(prefers-color-scheme: light)", content: "#ffffff" }',
      ),
      false,
    );

    // ThemeProvider uses deterministic DEFAULT_THEME ("dark") initial state and waits for hasSyncedStoredTheme
    assert.ok(
      themeContextSource.includes("const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);"),
    );
    assert.ok(themeContextSource.includes("if (!hasSyncedStoredTheme) return;"));
    assert.ok(themeContextSource.includes('THEME_STORAGE_KEY = "facetube-theme"'));

    // Light, Dark, and System toggle options remain available
    assert.ok(toggleSource.includes('value: "light"'));
    assert.ok(toggleSource.includes('value: "dark"'));
    assert.ok(toggleSource.includes('value: "system"'));
  });
});
