/**
 * Windowed access to a finished process's normalized transcript.
 *
 * `GET /api/execution-processes/{id}/entries?from_index=&limit=&include_thinking=`
 * serves a slice of the transcript the server already materializes (from its
 * normalized cache — no re-reading of the raw log, no re-normalizing). Two
 * things this buys over the old per-process WebSocket:
 *
 *  - a chat is rendered from a **window**, not from every entry it ever
 *    produced, so opening a long workspace no longer materializes tens of MB
 *    of transcript objects in the renderer;
 *  - `thinking` content is **withheld by default** (it is the largest single
 *    part of a reasoning-heavy transcript) and is fetched only when the
 *    operator actually expands it.
 *
 * `index` is the real transcript position — the same number the patch wire
 * uses for `/entries/{N}` — so `patchKey = <processId>:<index>` stays stable
 * no matter which window an entry arrived in.
 */

import type { PatchType } from 'shared/types';
import { useEffect } from 'react';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';

/** Entries requested per historic fetch. Small on purpose: this is a window. */
export const HISTORIC_WINDOW_ENTRIES = 200;

/** Per-process transcripts up to this size are worth keeping in the browser
 *  cache (they fit in one window and make a revisit instant). Longer ones are
 *  re-fetched as windows instead of being pinned in localStorage. */
export const CACHEABLE_TRANSCRIPT_ENTRIES = HISTORIC_WINDOW_ENTRIES;

/** Script turns render their output whole, so they are fetched whole. */
export const FULL_TRANSCRIPT_LIMIT = 200_000;

export interface HistoricWindowEntry {
  index: number;
  value: PatchType;
  /** Thinking entry whose content the server withheld. */
  thinking_omitted?: boolean;
}

/** Wire shape of `GET /api/execution-processes/{id}/entries` (snake_case, as
 *  the server serializes it). */
export interface HistoricWindow {
  entries: HistoricWindowEntry[];
  from_index: number;
  /** Exclusive end of the returned range. */
  end_index: number;
  total_entries: number;
  /** Older window to request next, or `null` at the beginning of the log. */
  next_from_index: number | null;
}

function endpoint(processId: string): string {
  return `/api/execution-processes/${processId}/entries`;
}

/**
 * Read a slice of a process transcript. `fromIndex` omitted asks for the
 * newest window (the end of the chat), which is what a first paint wants.
 */
export async function fetchHistoricWindow(options: {
  processId: string;
  fromIndex?: number;
  limit?: number;
  includeThinking?: boolean;
  signal?: AbortSignal;
}): Promise<HistoricWindow> {
  const query = new URLSearchParams();
  query.set('limit', String(options.limit ?? HISTORIC_WINDOW_ENTRIES));
  if (options.fromIndex !== undefined) {
    query.set('from_index', String(options.fromIndex));
  }
  if (options.includeThinking) {
    query.set('include_thinking', 'true');
  }

  // Plain same-origin GET: no origin/CSRF header is required for reads, and
  // keeping it off `makeRequest` avoids pulling that module's build-time
  // constants into every test that exercises the history loader.
  const response = await fetch(`${endpoint(options.processId)}?${query}`, {
    cache: 'no-store',
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to read transcript window (HTTP ${response.status}) for ${options.processId}`
    );
  }

  const payload = (await response.json()) as {
    success?: boolean;
    data?: HistoricWindow;
    message?: string;
  };
  if (!payload.success || !payload.data) {
    throw new Error(payload.message ?? 'Transcript response missing data');
  }

  // Guard the wire contract: a field that silently came back `undefined`
  // would make `hasOlder`/`startIndex` lie (e.g. a camelCase/snake_case drift
  // that TypeScript alone cannot catch, because the type asserts the shape).
  const data = payload.data;
  if (
    typeof data.from_index !== 'number' ||
    typeof data.total_entries !== 'number' ||
    !Array.isArray(data.entries)
  ) {
    throw new Error('Transcript window response is malformed');
  }
  return data;
}

// ---------------------------------------------------------------------------
// Thinking hydration
// ---------------------------------------------------------------------------

type ThinkingListener = (
  processId: string,
  index: number,
  content: string
) => void;

const thinkingListeners = new Set<ThinkingListener>();
/** Content fetched for an omitted thinking entry, keyed `<processId>:<index>`. */
const thinkingContent = new Map<string, string>();

function thinkingKey(processId: string, index: number): string {
  return `${processId}:${index}`;
}

/** Subscribe to hydrated thinking content (the history hook patches its own
 *  state and re-emits so the row re-renders). */
export function onThinkingHydrated(listener: ThinkingListener): () => void {
  thinkingListeners.add(listener);
  return () => {
    thinkingListeners.delete(listener);
  };
}

export function getHydratedThinking(
  processId: string,
  index: number
): string | null {
  return thinkingContent.get(thinkingKey(processId, index)) ?? null;
}

/**
 * Fetch the real content of an omitted thinking entry. Resolves `null` when
 * there is nothing to hydrate (already loaded, not a thinking entry, or the
 * request failed — the row simply stays collapsed/empty).
 */
export async function hydrateThinking(
  processId: string,
  index: number
): Promise<string | null> {
  const key = thinkingKey(processId, index);
  const cached = thinkingContent.get(key);
  if (cached !== undefined) {
    notify(processId, index, cached);
    return cached;
  }

  try {
    const window = await fetchHistoricWindow({
      processId,
      fromIndex: index,
      limit: 1,
      includeThinking: true,
    });
    const slot = window.entries.find((entry) => entry.index === index);
    const value = slot?.value as
      | { content?: { content?: unknown; entry_type?: { type?: string } } }
      | undefined;
    if (!slot || value?.content?.entry_type?.type !== 'thinking') return null;

    const content =
      typeof value.content?.content === 'string' ? value.content.content : '';
    thinkingContent.set(key, content);
    notify(processId, index, content);
    return content;
  } catch (error) {
    console.warn(`Failed to hydrate thinking for ${key}`, error);
    return null;
  }
}

function notify(processId: string, index: number, content: string): void {
  for (const listener of thinkingListeners) {
    try {
      listener(processId, index, content);
    } catch {
      /* a broken listener must not block the others */
    }
  }
}

/** Map a window onto keyed patches using the server's real indices. */
export function toKeyedEntries(
  window: HistoricWindow,
  processId: string
): PatchTypeWithKey[] {
  return window.entries.map((slot) => ({
    ...slot.value,
    patchKey: `${processId}:${slot.index}`,
    executionProcessId: processId,
  }));
}

/** Split `<processId>:<index>` — the patch-key format — back into its parts. */
function splitPatchKey(
  patchKey: string
): { processId: string; index: number } | null {
  const separator = patchKey.lastIndexOf(':');
  if (separator <= 0) return null;
  const index = Number(patchKey.slice(separator + 1));
  if (!Number.isInteger(index) || index < 0) return null;
  return { processId: patchKey.slice(0, separator), index };
}

/**
 * Fetch a thinking entry's real content the moment it is expanded. `content`
 * is the already-rendered text: once it is non-empty there is nothing left to
 * hydrate, which also stops the effect from re-running.
 */
export function useHydrateThinking(
  expanded: boolean,
  content: string,
  patchKey: string
): void {
  useEffect(() => {
    if (!expanded || content) return;
    const parts = splitPatchKey(patchKey);
    if (!parts) return;
    void hydrateThinking(parts.processId, parts.index);
  }, [expanded, content, patchKey]);
}

/** Same, for an aggregated group of thinking entries. */
export function useHydrateThinkingGroup(
  expanded: boolean,
  entries: readonly PatchTypeWithKey[]
): void {
  useEffect(() => {
    if (!expanded) return;
    for (const entry of entries) {
      if (entry.type !== 'NORMALIZED_ENTRY') continue;
      if (entry.content.entry_type.type !== 'thinking') continue;
      if (entry.content.content) continue;
      const parts = splitPatchKey(entry.patchKey);
      if (!parts) continue;
      void hydrateThinking(parts.processId, parts.index);
    }
    // `entries` identity changes whenever the window is extended; the content
    // guard inside keeps repeated calls from re-fetching what already landed.
  }, [expanded, entries]);
}
