import { useSyncExternalStore } from 'react';

export const ADDONS_ENABLED_STORAGE_KEY = 'aurapunk.settings.addons-enabled';

/** Every add-on id that ships with the app. */
export const ADDON_IDS = [
  'mem0',
  'jev_laya_suite',
  'graphify',
  'obsidian_mcp',
] as const;

export type AddonId = (typeof ADDON_IDS)[number];

const CHANGE_EVENT = 'aurapunk.settings.addons-enabled-changed';

let cachedRaw: string | null = null;
let cachedMap: Record<string, boolean> = {};

/**
 * All add-ons ship disabled: each needs the user to install and configure
 * something external before it does anything, so none should look active
 * before that happened. Mirrors `defaultEnabled` in AddonsSettingsSection.
 */
export const ADDON_DEFAULT_ENABLED: Record<AddonId, boolean> = {
  mem0: false,
  jev_laya_suite: false,
  graphify: false,
  obsidian_mcp: false,
};

function parse(raw: string | null): Record<string, boolean> {
  const initial: Record<string, boolean> = { ...ADDON_DEFAULT_ENABLED };
  if (!raw) return initial;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const id of ADDON_IDS) {
      const value = parsed[id];
      if (typeof value === 'boolean') initial[id] = value;
    }
  } catch {
    // Corrupt storage degrades to defaults; never blocks the UI.
  }
  return initial;
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(ADDONS_ENABLED_STORAGE_KEY);
  } catch {
    // Storage failures (private mode, quota) degrade to defaults.
    return null;
  }
}

function getSnapshot(): Record<string, boolean> {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedMap = parse(raw);
  }
  return cachedMap;
}

function getServerSnapshot(): Record<string, boolean> {
  return cachedMap;
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  // A toggle written by another tab or by the Settings dialog must repaint.
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

/**
 * Read whether an add-on is enabled. Shared by the Settings list and by the
 * sidebar indicators, so a disabled add-on never shows a fault color.
 */
export function useAddonEnabled(id: AddonId): boolean {
  return useSyncExternalStore(
    subscribe,
    () => Boolean(getSnapshot()[id]),
    () => Boolean(getServerSnapshot()[id])
  );
}

/** Reactive read of every add-on at once, for the Settings list. */
export function useAddonEnabledMap(): Record<string, boolean> {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Non-reactive read, for code that cannot use hooks. */
export function isAddonEnabled(id: AddonId): boolean {
  return Boolean(getSnapshot()[id]);
}

export function setAddonEnabled(id: AddonId, enabled: boolean): void {
  const next = { ...getSnapshot(), [id]: enabled };
  try {
    window.localStorage.setItem(
      ADDONS_ENABLED_STORAGE_KEY,
      JSON.stringify(next)
    );
  } catch {
    // Storage failures degrade silently; the session keeps the new value.
  }
  cachedRaw = null;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}