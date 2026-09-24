export const THEME_STORAGE_KEY = "workboard.theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function readThemePreference(): ThemePreference {
  const stored = storage()?.getItem(THEME_STORAGE_KEY) ?? null;
  return isThemePreference(stored) ? stored : "system";
}

export function systemTheme(): ResolvedTheme {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

export function resolvedTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

export function applyThemePreference(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    const target = storage();
    if (target === null) return;
    if (preference === "system") target.removeItem(THEME_STORAGE_KEY);
    else target.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Private browsing and locked-down storage must not break the dashboard.
  } finally {
    applyThemePreference(preference);
  }
}

/** Apply the stored preference before the application renders to avoid a flash. */
export function initializeTheme(): ThemePreference {
  const preference = readThemePreference();
  applyThemePreference(preference);
  return preference;
}
