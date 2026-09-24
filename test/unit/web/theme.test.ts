import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  applyThemePreference,
  initializeTheme,
  readThemePreference,
  resolvedTheme,
  saveThemePreference,
  systemTheme,
  THEME_STORAGE_KEY,
} from "../../../src/web/theme";

interface StorageStub {
  readonly values: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface RootStub {
  readonly attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

let storage: StorageStub;
let root: RootStub;
let systemDark = false;
let previousLocalStorage: unknown;
let previousDocument: unknown;
let previousWindow: unknown;

beforeEach(() => {
  storage = {
    values: new Map(),
    getItem: (key) => storage.values.get(key) ?? null,
    setItem: (key, value) => void storage.values.set(key, value),
    removeItem: (key) => void storage.values.delete(key),
  };
  root = {
    attributes: new Map(),
    setAttribute: (name, value) => void root.attributes.set(name, value),
    removeAttribute: (name) => void root.attributes.delete(name),
  };
  systemDark = false;
  previousLocalStorage = (globalThis as any).localStorage;
  previousDocument = (globalThis as any).document;
  previousWindow = (globalThis as any).window;
  (globalThis as any).localStorage = storage;
  (globalThis as any).document = { documentElement: root };
  (globalThis as any).window = {
    matchMedia: () => ({ matches: systemDark }),
  };
});

afterEach(() => {
  if (previousLocalStorage === undefined) delete (globalThis as any).localStorage;
  else (globalThis as any).localStorage = previousLocalStorage;
  if (previousDocument === undefined) delete (globalThis as any).document;
  else (globalThis as any).document = previousDocument;
  if (previousWindow === undefined) delete (globalThis as any).window;
  else (globalThis as any).window = previousWindow;
});

describe("theme preference", () => {
  test("defaults to System and resolves against the operating-system preference", () => {
    systemDark = true;

    expect(readThemePreference()).toBe("system");
    expect(systemTheme()).toBe("dark");
    expect(resolvedTheme("system")).toBe("dark");
    expect(initializeTheme()).toBe("system");
    expect(root.attributes.has("data-theme")).toBe(false);
  });

  test("persists and applies an explicit Light choice", () => {
    systemDark = true;

    saveThemePreference("light");

    expect(storage.values.get(THEME_STORAGE_KEY)).toBe("light");
    expect(root.attributes.get("data-theme")).toBe("light");
    expect(resolvedTheme("light")).toBe("light");
  });

  test("persists and applies an explicit Dark choice even on a light system", () => {
    saveThemePreference("dark");

    expect(storage.values.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(root.attributes.get("data-theme")).toBe("dark");
    expect(resolvedTheme("dark")).toBe("dark");
  });

  test("resetting to System removes the manual override and saved value", () => {
    saveThemePreference("dark");
    saveThemePreference("system");

    expect(storage.values.has(THEME_STORAGE_KEY)).toBe(false);
    expect(root.attributes.has("data-theme")).toBe(false);
  });

  test("invalid stored values fail closed to System", () => {
    storage.setItem(THEME_STORAGE_KEY, "midnight");

    expect(readThemePreference()).toBe("system");
    applyThemePreference("system");
    expect(root.attributes.has("data-theme")).toBe(false);
  });
});
