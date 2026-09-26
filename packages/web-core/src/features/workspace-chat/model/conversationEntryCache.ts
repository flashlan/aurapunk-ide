import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';
import type { ExecutionProcess } from 'shared/types';

// ---------------------------------------------------------------------------
// Conversation-entry cache
// ---------------------------------------------------------------------------
// Per-execution-process cache of normalized conversation entries. The chat
// reloads these over a websocket stream every time a workspace/session is
// (re)mounted — which is what happens when the operator clicks between two
// workspaces. Finished (historic) processes have stable logs, so caching them
// in the browser makes switching back to a previously-viewed workspace
// instant instead of re-streaming the whole chat.
//
// The cache is a process-global singleton (survives remounts within a page
// session) mirrored to localStorage (survives full page reloads). Sending a
// message is unaffected: it goes to the backend via POST /follow-up and never
// reads from this cache.
//
// GLOBAL BUDGET (2026-09-24): the old policy was a per-process 4 MiB localStorage
// ceiling with no aggregate cap — 60 processes × 4 MiB is 240 MiB, far past the
// ~5 MiB localStorage quota, so late writes failed silently while every copy
// stayed resident in the `MEMORY` map with no bound at all. Both planes now
// have an explicit byte budget with insertion-order (LRU-ish) eviction:
// `MAX_MEMORY_BYTES` for RAM, `MAX_TOTAL_STORAGE_BYTES` for localStorage.

const MEMORY = new Map<string, PatchTypeWithKey[]>();
const PROCESS_MEMORY = new Map<string, ExecutionProcess[]>();
const STORAGE_KEY = 'vibe-conversation-entries';
const PROCESS_STORAGE_KEY = 'vibe-conversation-processes';
const ENTRY_STORAGE_PREFIX = 'vibe-conversation-entry:';
const PROCESS_STORAGE_PREFIX = 'vibe-conversation-process:';

/** Distinct processes kept before the oldest is dropped (insertion order). */
const MAX_PROCESSES = 60;
/** One transcript's localStorage ceiling (was 4 MiB — see header). */
const MAX_PROCESS_STORAGE_BYTES = 512 * 1024;
/** Sum of all `vibe-conversation-entry:*` values in localStorage. */
const MAX_TOTAL_STORAGE_BYTES = 3 * 1024 * 1024;
/** Sum of all transcripts held in the in-memory map. */
const MAX_MEMORY_BYTES = 8 * 1024 * 1024;
/** Serialized ceiling for one scope's process manifest. */
const MAX_MANIFEST_STORAGE_BYTES = 64 * 1024;
/** Pre-v2 aggregate (`vibe-conversation-entries`) — only worth parsing when
 *  it is small; anything larger is dropped so it can never pin megabytes. */
const MAX_LEGACY_AGGREGATE_BYTES = 1024 * 1024;
const MAX_PROCESS_SNAPSHOTS = 60;

let entriesStorageSnapshot: Record<string, PatchTypeWithKey[]> | null = null;
let processStorageSnapshot: Record<string, ExecutionProcess[]> | null = null;

/** Insertion-ordered process ids present in `MEMORY`. */
const memoryOrder: string[] = [];
const memoryBytes = new Map<string, number>();
let memoryTotalBytes = 0;

/** Insertion-ordered process ids persisted under `ENTRY_STORAGE_PREFIX`. */
const storageOrder: string[] = [];
const storageBytes = new Map<string, number>();
let storageTotalBytes = 0;
let storageBudgetSeeded = false;

function storageKey(prefix: string, id: string): string {
  return `${prefix}${encodeURIComponent(id)}`;
}

function byteLength(text: string): number {
  // Sizes are a budget, not a billing meter: UTF-16 code units are close
  // enough to UTF-8 bytes for latin-heavy transcripts and cost nothing to
  // count versus TextEncoder on every write.
  return text.length;
}

/** Walk the entry keys once so eviction decisions have real sizes. */
function seedStorageBudget(): void {
  if (storageBudgetSeeded) return;
  storageBudgetSeeded = true;
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(ENTRY_STORAGE_PREFIX)) continue;
      const value = localStorage.getItem(key);
      if (value === null) continue;
      const id = decodeURIComponent(key.slice(ENTRY_STORAGE_PREFIX.length));
      const size = byteLength(value);
      storageOrder.push(id);
      storageBytes.set(id, size);
      storageTotalBytes += size;
    }
  } catch {
    // Storage unavailable — budgets stay at zero and nothing is persisted.
  }
}

function removeFromStorageOrder(id: string): void {
  const size = storageBytes.get(id);
  if (size === undefined) return;
  storageTotalBytes -= size;
  storageBytes.delete(id);
  const index = storageOrder.indexOf(id);
  if (index !== -1) storageOrder.splice(index, 1);
}

function dropStorageKey(id: string): void {
  removeFromStorageOrder(id);
  try {
    localStorage.removeItem(storageKey(ENTRY_STORAGE_PREFIX, id));
  } catch {
    // ignore
  }
}

function enforceStorageBudget(): void {
  seedStorageBudget();
  while (
    storageTotalBytes > MAX_TOTAL_STORAGE_BYTES &&
    storageOrder.length > 1
  ) {
    const oldest = storageOrder[0];
    if (oldest === undefined) break;
    dropStorageKey(oldest);
  }
}

function makeRoomFor(processId: string, incoming: number): void {
  seedStorageBudget();
  const replaced = storageBytes.get(processId) ?? 0;
  while (
    storageTotalBytes - replaced + incoming > MAX_TOTAL_STORAGE_BYTES &&
    storageOrder.length > 0
  ) {
    const oldest = storageOrder.find((id) => id !== processId);
    if (oldest === undefined) break;
    dropStorageKey(oldest);
  }
}

/** Mark a persisted transcript as recently used without rewriting it. */
function touchStorageOrder(processId: string): void {
  const index = storageOrder.indexOf(processId);
  if (index === -1) return;
  storageOrder.splice(index, 1);
  storageOrder.push(processId);
}

function rememberInMemory(
  processId: string,
  entries: PatchTypeWithKey[],
  knownSize?: number
): void {
  const previous = memoryBytes.get(processId);
  if (previous !== undefined) {
    memoryTotalBytes -= previous;
    const index = memoryOrder.indexOf(processId);
    if (index !== -1) memoryOrder.splice(index, 1);
  }

  MEMORY.set(processId, entries);
  memoryOrder.push(processId);
  const size =
    knownSize ??
    (entries.length === 0 ? 0 : byteLength(JSON.stringify(entries)));
  memoryBytes.set(processId, size);
  memoryTotalBytes += size;

  while (
    memoryTotalBytes > MAX_MEMORY_BYTES ||
    memoryOrder.length > MAX_PROCESSES
  ) {
    if (memoryOrder.length <= 1) break;
    const oldest = memoryOrder[0];
    if (oldest === undefined) break;
    memoryTotalBytes -= memoryBytes.get(oldest) ?? 0;
    memoryBytes.delete(oldest);
    memoryOrder.splice(0, 1);
    MEMORY.delete(oldest);
  }
}

function forgetInMemory(processId: string): void {
  const size = memoryBytes.get(processId);
  if (size === undefined) return;
  memoryTotalBytes -= size;
  memoryBytes.delete(processId);
  const index = memoryOrder.indexOf(processId);
  if (index !== -1) memoryOrder.splice(index, 1);
  MEMORY.delete(processId);
}

function readEntriesStorage(): Record<string, PatchTypeWithKey[]> {
  if (entriesStorageSnapshot) return entriesStorageSnapshot;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && byteLength(raw) > MAX_LEGACY_AGGREGATE_BYTES) {
      // A pre-v2 aggregate that big would be pinned in memory on every read
      // and is almost certainly the very thing blowing the quota. Drop it;
      // the affected transcripts simply re-stream once and re-cache per-key.
      localStorage.removeItem(STORAGE_KEY);
      entriesStorageSnapshot = {};
      return entriesStorageSnapshot;
    }
    entriesStorageSnapshot = raw
      ? (JSON.parse(raw) as Record<string, PatchTypeWithKey[]>)
      : {};
  } catch {
    entriesStorageSnapshot = {};
  }

  return entriesStorageSnapshot;
}

function readProcessStorage(): Record<string, ExecutionProcess[]> {
  if (processStorageSnapshot) return processStorageSnapshot;

  try {
    const raw = localStorage.getItem(PROCESS_STORAGE_KEY);
    processStorageSnapshot = raw
      ? (JSON.parse(raw) as Record<string, ExecutionProcess[]>)
      : {};
  } catch {
    processStorageSnapshot = {};
  }

  return processStorageSnapshot;
}

function writeEntryStorage(
  processId: string,
  entries: PatchTypeWithKey[]
): void {
  try {
    seedStorageBudget();
    const serialized = JSON.stringify(entries);
    const size = byteLength(serialized);
    if (size > MAX_PROCESS_STORAGE_BYTES) {
      // Too big for a single slot: drop any previous copy so the budget is
      // released rather than leaving a stale one behind.
      dropStorageKey(processId);
      return;
    }

    // Make room BEFORE writing. A store that is already at the WebKit quota
    // (left behind by the old 4 MiB-per-process policy) would otherwise fail
    // every setItem, and the post-write eviction below would never run.
    makeRoomFor(processId, size);

    const key = storageKey(ENTRY_STORAGE_PREFIX, processId);
    // Commit to storage FIRST: on quota failure the previous value (and its
    // bookkeeping) is still what's on disk, so the totals stay truthful.
    localStorage.setItem(key, serialized);

    const previous = storageBytes.get(processId);
    if (previous !== undefined) storageTotalBytes -= previous;
    else storageOrder.push(processId);
    storageBytes.set(processId, size);
    storageTotalBytes += size;
    // Move to the most-recent end so eviction prefers untouched transcripts.
    const index = storageOrder.indexOf(processId);
    if (index !== -1) {
      storageOrder.splice(index, 1);
      storageOrder.push(processId);
    }
    enforceStorageBudget();
  } catch {
    // Quota or serialization failure — memory cache still works.
  }
}

function writeProcessStorage(
  scopeKey: string,
  processes: ExecutionProcess[]
): void {
  try {
    const serialized = JSON.stringify(processes);
    if (byteLength(serialized) > MAX_MANIFEST_STORAGE_BYTES) return;
    localStorage.setItem(
      storageKey(PROCESS_STORAGE_PREFIX, scopeKey),
      serialized
    );
  } catch {
    // Quota or serialization failure — the in-memory snapshot still works.
  }
}

export function getCachedEntries(
  processId: string
): PatchTypeWithKey[] | undefined {
  const fromMemory = MEMORY.get(processId);
  if (fromMemory) return fromMemory;

  try {
    const raw = localStorage.getItem(
      storageKey(ENTRY_STORAGE_PREFIX, processId)
    );
    if (raw) {
      const entries = JSON.parse(raw) as PatchTypeWithKey[];
      // Already persisted under its own key: only refresh recency. Writing it
      // back would re-serialize megabytes synchronously on every cache hit.
      seedStorageBudget();
      touchStorageOrder(processId);
      rememberInMemory(processId, entries, byteLength(raw));
      return entries;
    }
  } catch {
    // Corrupt or unavailable — fall through to the legacy aggregate.
  }

  // Read the pre-v2 aggregate only for entries that have not been promoted to
  // their own key yet, and promote them once.
  const legacy = readEntriesStorage()[processId];
  if (legacy) {
    rememberInMemory(processId, legacy);
    writeEntryStorage(processId, legacy);
    return legacy;
  }
  return undefined;
}

export function setCachedEntries(
  processId: string,
  entries: PatchTypeWithKey[]
): void {
  rememberInMemory(processId, entries);
  writeEntryStorage(processId, entries);
}

/**
 * Store the last known process list for a workspace/session scope.
 *
 * The execution-process WebSocket sends this list asynchronously. Keeping a
 * small snapshot lets the conversation render cached entries before the live
 * snapshot arrives; the live list remains authoritative and replaces it as
 * soon as it is available.
 */
export function setCachedExecutionProcesses(
  scopeKey: string,
  processes: ExecutionProcess[]
): void {
  PROCESS_MEMORY.set(scopeKey, processes);

  if (PROCESS_MEMORY.size > MAX_PROCESS_SNAPSHOTS) {
    const oldest = PROCESS_MEMORY.keys().next().value;
    if (oldest !== undefined) PROCESS_MEMORY.delete(oldest);
  }

  writeProcessStorage(scopeKey, processes);
}

export function getCachedExecutionProcesses(
  scopeKey: string
): ExecutionProcess[] | undefined {
  const fromMemory = PROCESS_MEMORY.get(scopeKey);
  if (fromMemory) return fromMemory;

  try {
    const raw = localStorage.getItem(
      storageKey(PROCESS_STORAGE_PREFIX, scopeKey)
    );
    if (raw) {
      const processes = JSON.parse(raw) as ExecutionProcess[];
      PROCESS_MEMORY.set(scopeKey, processes);
      return processes;
    }
  } catch {
    // Corrupt or unavailable — fall through to the legacy aggregate.
  }

  const legacy = readProcessStorage()[scopeKey];
  if (legacy) {
    PROCESS_MEMORY.set(scopeKey, legacy);
    writeProcessStorage(scopeKey, legacy);
    return legacy;
  }
  return undefined;
}

export function deleteCachedEntries(processId: string): void {
  forgetInMemory(processId);
  dropStorageKey(processId);
}

function removePrefixedStorageKeys(prefixes: string[]): void {
  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch {
    // ignore
  }
}

export function clearConversationEntryCache(): void {
  MEMORY.clear();
  PROCESS_MEMORY.clear();
  memoryOrder.length = 0;
  memoryBytes.clear();
  memoryTotalBytes = 0;
  storageOrder.length = 0;
  storageBytes.clear();
  storageTotalBytes = 0;
  storageBudgetSeeded = false;
  entriesStorageSnapshot = null;
  processStorageSnapshot = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PROCESS_STORAGE_KEY);
  } catch {
    // ignore
  }
  removePrefixedStorageKeys([ENTRY_STORAGE_PREFIX, PROCESS_STORAGE_PREFIX]);
}
