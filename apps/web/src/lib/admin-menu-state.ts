export const ADMIN_MENU_OPEN_KEYS_STORAGE_KEY =
  "subscription-saas.admin.menu.openKeys";
export const ADMIN_MENU_SCROLL_TOP_STORAGE_KEY =
  "subscription-saas.admin.menu.scrollTop";

export interface AdminMenuStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AdminMenuState {
  openKeys: string[];
  scrollTop: number;
}

let memoryState: AdminMenuState | null = null;

export function getAdminMenuState(
  storage: AdminMenuStorage | undefined = getSessionStorage()
): AdminMenuState {
  if (memoryState) {
    return cloneState(memoryState);
  }

  memoryState = storage ? readStorageState(storage) : defaultState();
  return cloneState(memoryState);
}

export function resolveAdminMenuOpenKeys(
  cachedKeys: readonly string[],
  routeKeys: readonly string[],
  allowedKeys: ReadonlySet<string>
) {
  return uniqueKeys([...cachedKeys, ...routeKeys]).filter((key) => allowedKeys.has(key));
}

export function persistAdminMenuOpenKeys(
  keys: readonly string[],
  storage: AdminMenuStorage | undefined = getSessionStorage()
) {
  const current = ensureMemoryState(storage);
  memoryState = { ...current, openKeys: uniqueKeys(keys) };
  safelySetItem(
    storage,
    ADMIN_MENU_OPEN_KEYS_STORAGE_KEY,
    JSON.stringify(memoryState.openKeys)
  );
}

export function persistAdminMenuScrollTop(
  scrollTop: number,
  storage: AdminMenuStorage | undefined = getSessionStorage()
) {
  const current = ensureMemoryState(storage);
  memoryState = { ...current, scrollTop: normalizeScrollTop(scrollTop) };
  safelySetItem(
    storage,
    ADMIN_MENU_SCROLL_TOP_STORAGE_KEY,
    String(memoryState.scrollTop)
  );
}

export function resetAdminMenuStateForTests() {
  memoryState = null;
}

function ensureMemoryState(storage: AdminMenuStorage | undefined) {
  if (!memoryState) {
    memoryState = storage ? readStorageState(storage) : defaultState();
  }
  return memoryState;
}

function readStorageState(storage: AdminMenuStorage): AdminMenuState {
  try {
    return {
      openKeys: parseOpenKeys(storage.getItem(ADMIN_MENU_OPEN_KEYS_STORAGE_KEY)),
      scrollTop: normalizeScrollTop(
        Number(storage.getItem(ADMIN_MENU_SCROLL_TOP_STORAGE_KEY) ?? 0)
      )
    };
  } catch {
    return defaultState();
  }
}

function parseOpenKeys(rawValue: string | null) {
  if (!rawValue) {
    return [];
  }

  try {
    const value: unknown = JSON.parse(rawValue);
    return Array.isArray(value)
      ? uniqueKeys(value.filter((item): item is string => typeof item === "string"))
      : [];
  } catch {
    return [];
  }
}

function uniqueKeys(keys: readonly string[]) {
  return Array.from(new Set(keys));
}

function normalizeScrollTop(scrollTop: number) {
  return Number.isFinite(scrollTop) && scrollTop >= 0 ? scrollTop : 0;
}

function safelySetItem(
  storage: AdminMenuStorage | undefined,
  key: string,
  value: string
) {
  try {
    storage?.setItem(key, value);
  } catch {
    // Storage can be disabled by browser policy; in-memory continuity still works.
  }
}

function getSessionStorage(): AdminMenuStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

function defaultState(): AdminMenuState {
  return { openKeys: [], scrollTop: 0 };
}

function cloneState(state: AdminMenuState): AdminMenuState {
  return { openKeys: [...state.openKeys], scrollTop: state.scrollTop };
}
