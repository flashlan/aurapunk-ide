import { openLocalApiWebSocket } from '@/shared/lib/localApiTransport';

/**
 * Shared WebSocket client for the project-scoped board delta stream
 * (`GET /api/kanban/stream/ws?project_id=`).
 *
 * One socket per project serves every board collection subscribed to it — the
 * server multiplexes by table, so opening a socket per collection (issues,
 * statuses, tags, issue_tags, issue_relationships …) would multiply idle
 * connections for no benefit. Each `createFallbackSync` instance registers a
 * subscriber and receives only its own table's snapshot and row changes.
 *
 * Fallback contract: subscribers are told whenever the socket is no longer
 * usable so the caller can resume its 30 s poll; the poll stays disabled only
 * while a snapshot-backed stream is live. A drop therefore costs at most one
 * stale read, never a permanently frozen board.
 */

export type KanbanSocketState = 'connecting' | 'open' | 'closed';

export type KanbanRow = Record<string, unknown>;

export interface KanbanDeltaSubscription {
  /** Wire table name (`issues`, `tags`, …). */
  table: string;
  projectId: string;
  /** Mirror of `?minimal=1` on the fallback read — the server strips
   *  `description` / `extension_metadata` from issues when set. */
  minimal: boolean;
  /** Full replacement for the table. */
  onSnapshot: (rows: KanbanRow[]) => void;
  /** One row change. `row` is null for deletes. */
  onEvent: (op: 'upsert' | 'delete', row: KanbanRow | null, id: string) => void;
  /** Socket liveness — `open` means deltas are flowing, `closed` means the
   *  caller should fall back to polling. */
  onStateChange: (state: KanbanSocketState) => void;
}

type ServerMsg =
  | { type: 'snapshot'; table: string; rows: KanbanRow[] }
  | {
      type: 'event';
      seq: number;
      table: string;
      op: 'upsert' | 'delete';
      id: string;
      row?: KanbanRow;
    }
  | { type: 'ready'; table: string };

/** Tables the backend streams. Anything else keeps the plain poll. */
const DELTA_TABLES = new Set([
  'issues',
  'project_statuses',
  'tags',
  'issue_tags',
  'issue_relationships',
]);

export function supportsKanbanDeltas(table: string): boolean {
  return DELTA_TABLES.has(table);
}

interface Connection {
  projectId: string;
  socket: WebSocket | null;
  state: KanbanSocketState;
  subscriptions: Set<KanbanDeltaSubscription>;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
}

const connections = new Map<string, Connection>();
/** Matches the server's broadcast buffer: beyond this the server resnapshots. */
const MAX_RETRY_DELAY_MS = 8_000;

function setConnectionState(conn: Connection, state: KanbanSocketState): void {
  if (conn.state === state) return;
  conn.state = state;
  for (const sub of conn.subscriptions) {
    sub.onStateChange(state);
  }
}

function sendSubscribe(conn: Connection, sub: KanbanDeltaSubscription): void {
  if (!conn.socket || conn.socket.readyState !== WebSocket.OPEN) return;
  conn.socket.send(
    JSON.stringify({ subscribe: sub.table, minimal: sub.minimal })
  );
}

function scheduleRetry(conn: Connection): void {
  if (conn.retryTimer !== null || conn.subscriptions.size === 0) return;
  const delay = Math.min(
    MAX_RETRY_DELAY_MS,
    1000 * 2 ** Math.min(conn.retryAttempt, 3)
  );
  conn.retryAttempt += 1;
  conn.retryTimer = setTimeout(() => {
    conn.retryTimer = null;
    if (conn.subscriptions.size > 0) connect(conn);
  }, delay);
}

function handleMessage(conn: Connection, raw: unknown): void {
  if (typeof raw !== 'string') return;
  let msg: ServerMsg;
  try {
    msg = JSON.parse(raw) as ServerMsg;
  } catch {
    return;
  }

  for (const sub of conn.subscriptions) {
    if (msg.type === 'snapshot' && msg.table === sub.table) {
      sub.onSnapshot(msg.rows);
    } else if (msg.type === 'event' && msg.table === sub.table) {
      sub.onEvent(msg.op, msg.row ?? null, msg.id);
    }
    // `ready` carries no data — the snapshot it follows already replaced the
    // table — so it is intentionally ignored.
  }
}

function connect(conn: Connection): void {
  if (conn.socket) return;
  setConnectionState(conn, 'connecting');

  void openLocalApiWebSocket(
    `/api/kanban/stream/ws?project_id=${encodeURIComponent(conn.projectId)}`
  )
    .then((socket) => {
      // The connection may have been torn down (last subscriber left) while
      // the open was in flight.
      if (conn.subscriptions.size === 0) {
        socket.close();
        connections.delete(conn.projectId);
        return;
      }
      conn.socket = socket;
      conn.retryAttempt = 0;

      socket.onopen = () => {
        setConnectionState(conn, 'open');
        for (const sub of conn.subscriptions) sendSubscribe(conn, sub);
      };
      socket.onmessage = (event) => handleMessage(conn, event.data);
      socket.onerror = () => {
        // `onclose` always follows; there is nothing to do here but avoid an
        // unhandled error event.
      };
      socket.onclose = () => {
        conn.socket = null;
        if (conn.subscriptions.size === 0) {
          connections.delete(conn.projectId);
          return;
        }
        setConnectionState(conn, 'closed');
        scheduleRetry(conn);
      };
    })
    .catch(() => {
      if (conn.subscriptions.size === 0) {
        connections.delete(conn.projectId);
        return;
      }
      setConnectionState(conn, 'closed');
      scheduleRetry(conn);
    });
}

function getOrCreateConnection(projectId: string): Connection {
  const existing = connections.get(projectId);
  if (existing) return existing;

  const created: Connection = {
    projectId,
    socket: null,
    state: 'closed',
    subscriptions: new Set(),
    retryTimer: null,
    retryAttempt: 0,
  };
  connections.set(projectId, created);
  return created;
}

function teardownConnection(conn: Connection): void {
  if (conn.retryTimer !== null) {
    clearTimeout(conn.retryTimer);
    conn.retryTimer = null;
  }
  const socket = conn.socket;
  conn.socket = null;
  connections.delete(conn.projectId);
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
}

/**
 * Register a board collection on its project's delta stream. Returns the
 * unsubscribe function (safe to call more than once).
 */
export function subscribeKanbanDeltas(
  subscription: KanbanDeltaSubscription
): () => void {
  const conn = getOrCreateConnection(subscription.projectId);
  conn.subscriptions.add(subscription);

  if (conn.socket && conn.socket.readyState === WebSocket.OPEN) {
    sendSubscribe(conn, subscription);
  } else if (!conn.socket) {
    connect(conn);
  }
  // Socket exists but is still CONNECTING: `onopen` re-sends every
  // subscription, so this one is covered automatically.

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    conn.subscriptions.delete(subscription);
    if (conn.subscriptions.size === 0) teardownConnection(conn);
  };
}
