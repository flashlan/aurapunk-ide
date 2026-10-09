import { beforeAll, describe, expect, it } from 'vitest';
import {
  ADDON_DEFAULT_ENABLED,
  ADDON_IDS,
  isAddonEnabled,
  setAddonEnabled,
} from './addonPreferences';

const KEY = 'aurapunk.settings.addons-enabled';

// The web-core vitest config runs on `node` because it targets pure-logic
// units, so the storage surface this module touches has to be provided here.
class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

beforeAll(() => {
  const target = new EventTarget();
  Object.assign(target, { localStorage: new MemoryStorage() });
  (globalThis as unknown as { window: unknown }).window = target;
});

function clear(): void {
  window.localStorage.removeItem(KEY);
}

describe('add-on defaults', () => {
  it('ships every add-on disabled', () => {
    for (const id of ADDON_IDS) {
      expect(ADDON_DEFAULT_ENABLED[id]).toBe(false);
    }
  });

  it('reports every add-on as disabled on a fresh profile', () => {
    clear();
    for (const id of ADDON_IDS) {
      expect(isAddonEnabled(id)).toBe(false);
    }
  });
});

describe('setAddonEnabled', () => {
  it('persists a single toggle without disturbing the others', () => {
    clear();
    setAddonEnabled('jev_laya_suite', true);
    expect(isAddonEnabled('jev_laya_suite')).toBe(true);
    expect(isAddonEnabled('mem0')).toBe(false);
    expect(isAddonEnabled('graphify')).toBe(false);
    expect(isAddonEnabled('obsidian_mcp')).toBe(false);
  });

  it('round-trips through storage', () => {
    clear();
    setAddonEnabled('mem0', true);
    const stored = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    expect(stored.mem0).toBe(true);
  });

  it('ignores a corrupt payload and falls back to defaults', () => {
    window.localStorage.setItem(KEY, '{not json');
    expect(isAddonEnabled('mem0')).toBe(false);
    expect(isAddonEnabled('graphify')).toBe(false);
  });

  it('ignores non-boolean values stored under an add-on id', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ mem0: 'yes' }));
    expect(isAddonEnabled('mem0')).toBe(false);
  });

  it('notifies subscribers so the sidebar repaints', () => {
    clear();
    let calls = 0;
    const listener = () => {
      calls += 1;
    };
    window.addEventListener('aurapunk.settings.addons-enabled-changed', listener);
    setAddonEnabled('graphify', true);
    window.removeEventListener(
      'aurapunk.settings.addons-enabled-changed',
      listener
    );
    expect(calls).toBe(1);
  });
});