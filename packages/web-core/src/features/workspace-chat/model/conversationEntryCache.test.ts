import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getCachedEntries,
  setCachedEntries,
  deleteCachedEntries,
  clearConversationEntryCache,
} from './conversationEntryCache';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';

function makeEntries(processId: string, n: number): PatchTypeWithKey[] {
  return Array.from({ length: n }, (_, i) => ({
    type: 'NORMALIZED_ENTRY' as const,
    content: { entry_type: { type: 'user_message' }, content: `msg-${i}` },
    patchKey: `${processId}:${i}`,
    executionProcessId: processId,
  }));
}

// In-memory map is the source of truth for behavior; localStorage is a
// best-effort mirror guarded by try/catch, so tests run under the 'node'
// environment (no real localStorage) without breaking.
describe('conversationEntryCache', () => {
  beforeEach(() => clearConversationEntryCache());
  afterEach(() => clearConversationEntryCache());

  it('returns undefined for an unknown process id', () => {
    expect(getCachedEntries('missing')).toBeUndefined();
  });

  it('stores and retrieves entries by process id', () => {
    const entries = makeEntries('p1', 3);
    setCachedEntries('p1', entries);
    expect(getCachedEntries('p1')).toBe(entries);
  });

  it('keeps entries for separate processes independent', () => {
    setCachedEntries('a', makeEntries('a', 2));
    setCachedEntries('b', makeEntries('b', 5));
    expect(getCachedEntries('a')).toHaveLength(2);
    expect(getCachedEntries('b')).toHaveLength(5);
  });

  it('evicts the oldest entry past the capacity cap', () => {
    const cap = 60; // MAX_PROCESSES in the module
    for (let i = 0; i < cap + 1; i++) {
      setCachedEntries(`p${i}`, makeEntries(`p${i}`, 1));
    }
    // The first inserted key should have been evicted (insertion-order LRU).
    expect(getCachedEntries('p0')).toBeUndefined();
    expect(getCachedEntries(`p${cap}`)).toBeDefined();
  });

  it('delete removes a single process entry', () => {
    setCachedEntries('x', makeEntries('x', 1));
    deleteCachedEntries('x');
    expect(getCachedEntries('x')).toBeUndefined();
  });

  it('clear empties the whole cache', () => {
    setCachedEntries('a', makeEntries('a', 1));
    setCachedEntries('b', makeEntries('b', 1));
    clearConversationEntryCache();
    expect(getCachedEntries('a')).toBeUndefined();
    expect(getCachedEntries('b')).toBeUndefined();
  });

  it('mirrors entries to a mocked localStorage and reads them back from storage', () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;

    const entries = makeEntries('mirrored', 4);
    setCachedEntries('mirrored', entries);
    // Write path: the mirror persisted the entry to storage.
    expect(store.size).toBe(1);

    // Simulate a fresh page load: wipe in-memory map via clear(), then
    // re-seed storage exactly as it was persisted, and confirm hydration.
    clearConversationEntryCache();
    store.set(
      'vibe-conversation-entries',
      JSON.stringify({ mirrored: entries })
    );
    expect(getCachedEntries('mirrored')).toEqual(entries);

    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  describe('with an enumerable, quota-limited localStorage', () => {
    const ENTRY_PREFIX = 'vibe-conversation-entry:';
    let store: Map<string, string>;
    let setItemCalls: number;

    function installStorage(quotaChars: number) {
      store = new Map<string, string>();
      setItemCalls = 0;
      const used = () =>
        [...store.values()].reduce((sum, v) => sum + v.length, 0);
      (globalThis as { localStorage?: Storage }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          setItemCalls += 1;
          const previous = store.get(k)?.length ?? 0;
          if (used() - previous + v.length > quotaChars) {
            throw new Error('QuotaExceededError');
          }
          store.set(k, v);
        },
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
          return store.size;
        },
      } as Storage;
    }

    afterEach(() => {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    });

    it('does not rewrite a transcript that is already persisted under its own key', () => {
      installStorage(10 * 1024 * 1024);
      const entries = makeEntries('p1', 3);
      store.set(`${ENTRY_PREFIX}p1`, JSON.stringify(entries));

      expect(getCachedEntries('p1')).toEqual(entries);
      expect(setItemCalls).toBe(0);
    });

    it('prunes oversized and over-budget leftovers on the first read, without any write', () => {
      installStorage(10 * 1024 * 1024);
      // An oversized slot left by the old 4 MiB-per-process policy...
      store.set(`${ENTRY_PREFIX}huge`, 'x'.repeat(600_000));
      // ...plus enough ordinary slots to exceed the 3 MiB total budget.
      for (let i = 0; i < 8; i += 1) {
        store.set(`${ENTRY_PREFIX}old-${i}`, 'x'.repeat(500_000));
      }
      const entries = makeEntries('recent', 2);
      store.set(`${ENTRY_PREFIX}recent`, JSON.stringify(entries));

      expect(getCachedEntries('recent')).toEqual(entries);

      expect(store.has(`${ENTRY_PREFIX}huge`)).toBe(false);
      const total = [...store.entries()]
        .filter(([k]) => k.startsWith(ENTRY_PREFIX))
        .reduce((sum, [, v]) => sum + v.length, 0);
      expect(total).toBeLessThanOrEqual(3 * 1024 * 1024);
      expect(store.has(`${ENTRY_PREFIX}recent`)).toBe(true);
      expect(setItemCalls).toBe(0);
    });

    it('evicts older transcripts before writing when the store is at quota', () => {
      // Mirrors a real profile left at the WebKit quota by the old
      // 4 MiB-per-process policy: six ~500K transcripts and no headroom.
      installStorage(3_200_000);
      for (let i = 0; i < 6; i += 1) {
        store.set(`${ENTRY_PREFIX}old-${i}`, 'x'.repeat(520_000));
      }

      const fresh = makeEntries('fresh', 1);
      fresh[0]!.content = {
        entry_type: { type: 'user_message' },
        content: 'y'.repeat(100_000),
      } as PatchTypeWithKey['content'];
      setCachedEntries('fresh', fresh);

      expect(store.has(`${ENTRY_PREFIX}fresh`)).toBe(true);
      expect(store.has(`${ENTRY_PREFIX}old-0`)).toBe(false);
    });
  });
});
