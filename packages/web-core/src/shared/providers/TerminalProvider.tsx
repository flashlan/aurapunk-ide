import { useReducer, useMemo, useCallback, useRef, ReactNode } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import {
  TerminalContext,
  type TerminalTab,
  type TerminalInstance,
} from '@/shared/hooks/useTerminal';
import { openLocalApiWebSocket } from '@/shared/lib/localApiTransport';

interface TerminalConnection {
  ws: WebSocket;
  send: (data: string) => void;
  resize: (cols: number, rows: number) => void;
}

interface TerminalState {
  tabsByWorkspace: Record<string, TerminalTab[]>;
  activeTabByWorkspace: Record<string, string | null>;
  tabsByProject: Record<string, TerminalTab[]>;
  activeTabByProject: Record<string, string | null>;
}

/**
 * xterm callbacks can run one tick after a terminal is closed. Mark the
 * instance before disposing it so mounted views can ignore those callbacks
 * instead of calling into xterm's disposed private core.
 */
function disposeTerminalInstance(instance: TerminalInstance): void {
  (
    instance.terminal as Terminal & { __aurapunkDisposed?: boolean }
  ).__aurapunkDisposed = true;
  instance.terminal.dispose();
}

type TerminalAction =
  | {
      type: 'CREATE_TAB';
      workspaceId: string;
      cwd: string;
      executionProcessId?: string;
      isTui?: boolean;
    }
  | {
      type: 'OPEN_OR_FOCUS_TAB';
      workspaceId: string;
      cwd: string;
      executionProcessId?: string;
      isTui?: boolean;
    }
  | { type: 'CLOSE_TAB'; workspaceId: string; tabId: string }
  | { type: 'SET_ACTIVE_TAB'; workspaceId: string; tabId: string }
  | {
      type: 'UPDATE_TAB_TITLE';
      workspaceId: string;
      tabId: string;
      title: string;
    }
  | {
      type: 'UPDATE_TAB_CWD';
      workspaceId: string;
      tabId: string;
      cwd: string;
    }
  | {
      type: 'SET_TMUX_SESSION';
      workspaceId: string;
      tabId: string;
      tmuxSessionName: string;
    }
  | { type: 'CLEAR_WORKSPACE_TABS'; workspaceId: string }
  | {
      type: 'CREATE_PROJECT_TAB';
      projectId: string;
      repoPath: string;
      isTui?: boolean;
    }
  | { type: 'CLOSE_PROJECT_TAB'; projectId: string; tabId: string }
  | { type: 'SET_ACTIVE_PROJECT_TAB'; projectId: string; tabId: string }
  | {
      type: 'UPDATE_PROJECT_TAB_TITLE';
      projectId: string;
      tabId: string;
      title: string;
    }
  | {
      type: 'UPDATE_PROJECT_TAB_CWD';
      projectId: string;
      tabId: string;
      cwd: string;
    }
  | {
      type: 'SET_PROJECT_TAB_TMUX_SESSION';
      projectId: string;
      tabId: string;
      tmuxSessionName: string;
    }
  | { type: 'CLEAR_PROJECT_TABS'; projectId: string };

function generateTabId(): string {
  return `term-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function encodeBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binString = Array.from(bytes, (b) => String.fromCodePoint(b)).join('');
  return btoa(binString);
}

function decodeBase64(base64: string): string {
  const binString = atob(base64);
  const bytes = Uint8Array.from(binString, (c) => c.codePointAt(0)!);
  return new TextDecoder().decode(bytes);
}

/** Append a new tab for a workspace and make it active. */
function addWorkspaceTab(
  state: TerminalState,
  workspaceId: string,
  cwd: string,
  executionProcessId?: string,
  isTui?: boolean
): TerminalState {
  const existingTabs = state.tabsByWorkspace[workspaceId] || [];
  const newTab: TerminalTab = {
    id: generateTabId(),
    title: isTui
      ? '⚡ Cockpit (TUI)'
      : executionProcessId
        ? 'Agent'
        : `Workspace ${existingTabs.length + 1} Terminal`,
    workspaceId,
    cwd,
    executionProcessId,
    isTui,
  };
  return {
    ...state,
    tabsByWorkspace: {
      ...state.tabsByWorkspace,
      [workspaceId]: [...existingTabs, newTab],
    },
    activeTabByWorkspace: {
      ...state.activeTabByWorkspace,
      [workspaceId]: newTab.id,
    },
  };
}

/** Append a new tab for a project/repo and make it active. */
function addProjectTab(
  state: TerminalState,
  projectId: string,
  repoPath: string,
  isTui?: boolean
): TerminalState {
  const existingTabs = state.tabsByProject[projectId] || [];
  const newTab: TerminalTab = {
    id: generateTabId(),
    title: isTui
      ? '⚡ Cockpit (TUI)'
      : `Project Terminal ${existingTabs.length + 1}`,
    projectId,
    repoPath,
    cwd: repoPath,
    isTui,
  };
  return {
    ...state,
    tabsByProject: {
      ...state.tabsByProject,
      [projectId]: [...existingTabs, newTab],
    },
    activeTabByProject: {
      ...state.activeTabByProject,
      [projectId]: newTab.id,
    },
  };
}

function terminalReducer(
  state: TerminalState,
  action: TerminalAction
): TerminalState {
  switch (action.type) {
    case 'CREATE_TAB': {
      const { workspaceId, cwd, executionProcessId, isTui } = action;
      return addWorkspaceTab(
        state,
        workspaceId,
        cwd,
        executionProcessId,
        isTui
      );
    }

    case 'OPEN_OR_FOCUS_TAB': {
      const { workspaceId, cwd, executionProcessId, isTui } = action;
      const existingTabs = state.tabsByWorkspace[workspaceId] || [];
      // Idempotent attach: reuse an existing tab bound to the same session
      // instead of opening a duplicate.
      if (executionProcessId) {
        const match = existingTabs.find(
          (t) => t.executionProcessId === executionProcessId
        );
        if (match) {
          return {
            ...state,
            activeTabByWorkspace: {
              ...state.activeTabByWorkspace,
              [workspaceId]: match.id,
            },
          };
        }
      }
      return addWorkspaceTab(
        state,
        workspaceId,
        cwd,
        executionProcessId,
        isTui
      );
    }

    case 'CLOSE_TAB': {
      const { tabId } = action;
      const newTabsByWorkspace: Record<string, TerminalTab[]> = {};
      const newActiveTabByWorkspace: Record<string, string | null> = {};

      for (const [wId, wTabs] of Object.entries(state.tabsByWorkspace)) {
        const filtered = wTabs.filter((t) => t.id !== tabId);
        newTabsByWorkspace[wId] = filtered;

        const wasActive = state.activeTabByWorkspace[wId] === tabId;
        if (wasActive && filtered.length > 0) {
          const closedIndex = wTabs.findIndex((t) => t.id === tabId);
          const newIndex = Math.max(
            0,
            Math.min(closedIndex, filtered.length - 1)
          );
          newActiveTabByWorkspace[wId] = filtered[newIndex]?.id ?? null;
        } else if (filtered.length === 0) {
          newActiveTabByWorkspace[wId] = null;
        } else {
          newActiveTabByWorkspace[wId] =
            state.activeTabByWorkspace[wId] ?? null;
        }
      }

      return {
        ...state,
        tabsByWorkspace: newTabsByWorkspace,
        activeTabByWorkspace: newActiveTabByWorkspace,
      };
    }

    case 'SET_ACTIVE_TAB': {
      const { workspaceId, tabId } = action;
      return {
        ...state,
        activeTabByWorkspace: {
          ...state.activeTabByWorkspace,
          [workspaceId]: tabId,
        },
      };
    }

    case 'UPDATE_TAB_TITLE': {
      const { workspaceId, tabId, title } = action;
      const tabs = state.tabsByWorkspace[workspaceId] || [];
      return {
        ...state,
        tabsByWorkspace: {
          ...state.tabsByWorkspace,
          [workspaceId]: tabs.map((t) =>
            t.id === tabId ? { ...t, title } : t
          ),
        },
      };
    }

    case 'UPDATE_TAB_CWD': {
      const { workspaceId, tabId, cwd } = action;
      const tabs = state.tabsByWorkspace[workspaceId] || [];
      return {
        ...state,
        tabsByWorkspace: {
          ...state.tabsByWorkspace,
          [workspaceId]: tabs.map((t) => (t.id === tabId ? { ...t, cwd } : t)),
        },
      };
    }

    case 'SET_TMUX_SESSION': {
      const { workspaceId, tabId, tmuxSessionName } = action;
      const tabs = state.tabsByWorkspace[workspaceId] || [];
      return {
        ...state,
        tabsByWorkspace: {
          ...state.tabsByWorkspace,
          [workspaceId]: tabs.map((t) =>
            t.id === tabId ? { ...t, tmuxSessionName } : t
          ),
        },
      };
    }

    case 'CLEAR_WORKSPACE_TABS': {
      const { workspaceId } = action;
      const restTabs = Object.fromEntries(
        Object.entries(state.tabsByWorkspace).filter(
          ([key]) => key !== workspaceId
        )
      );
      const restActive = Object.fromEntries(
        Object.entries(state.activeTabByWorkspace).filter(
          ([key]) => key !== workspaceId
        )
      );
      return {
        ...state,
        tabsByWorkspace: restTabs,
        activeTabByWorkspace: restActive,
      };
    }

    case 'CREATE_PROJECT_TAB': {
      const { projectId, repoPath, isTui } = action;
      return addProjectTab(state, projectId, repoPath, isTui);
    }

    case 'CLOSE_PROJECT_TAB': {
      const { tabId } = action;
      const newTabsByProject: Record<string, TerminalTab[]> = {};
      const newActiveTabByProject: Record<string, string | null> = {};

      for (const [pId, pTabs] of Object.entries(state.tabsByProject)) {
        const filtered = pTabs.filter((t) => t.id !== tabId);
        newTabsByProject[pId] = filtered;

        const wasActive = state.activeTabByProject[pId] === tabId;
        if (wasActive && filtered.length > 0) {
          const closedIndex = pTabs.findIndex((t) => t.id === tabId);
          const newIndex = Math.max(
            0,
            Math.min(closedIndex, filtered.length - 1)
          );
          newActiveTabByProject[pId] = filtered[newIndex]?.id ?? null;
        } else if (filtered.length === 0) {
          newActiveTabByProject[pId] = null;
        } else {
          newActiveTabByProject[pId] = state.activeTabByProject[pId] ?? null;
        }
      }

      return {
        ...state,
        tabsByProject: newTabsByProject,
        activeTabByProject: newActiveTabByProject,
      };
    }

    case 'SET_ACTIVE_PROJECT_TAB': {
      const { projectId, tabId } = action;
      return {
        ...state,
        activeTabByProject: {
          ...state.activeTabByProject,
          [projectId]: tabId,
        },
      };
    }

    case 'UPDATE_PROJECT_TAB_TITLE': {
      const { projectId, tabId, title } = action;
      const tabs = state.tabsByProject[projectId] || [];
      return {
        ...state,
        tabsByProject: {
          ...state.tabsByProject,
          [projectId]: tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
        },
      };
    }

    case 'UPDATE_PROJECT_TAB_CWD': {
      const { projectId, tabId, cwd } = action;
      const tabs = state.tabsByProject[projectId] || [];
      return {
        ...state,
        tabsByProject: {
          ...state.tabsByProject,
          [projectId]: tabs.map((t) => (t.id === tabId ? { ...t, cwd } : t)),
        },
      };
    }

    case 'SET_PROJECT_TAB_TMUX_SESSION': {
      const { projectId, tabId, tmuxSessionName } = action;
      const tabs = state.tabsByProject[projectId] || [];
      return {
        ...state,
        tabsByProject: {
          ...state.tabsByProject,
          [projectId]: tabs.map((t) =>
            t.id === tabId ? { ...t, tmuxSessionName } : t
          ),
        },
      };
    }

    case 'CLEAR_PROJECT_TABS': {
      const { projectId } = action;
      const restTabs = Object.fromEntries(
        Object.entries(state.tabsByProject).filter(([key]) => key !== projectId)
      );
      const restActive = Object.fromEntries(
        Object.entries(state.activeTabByProject).filter(
          ([key]) => key !== projectId
        )
      );
      return {
        ...state,
        tabsByProject: restTabs,
        activeTabByProject: restActive,
      };
    }

    default:
      return state;
  }
}

interface TerminalProviderProps {
  children: ReactNode;
}

export function TerminalProvider({ children }: TerminalProviderProps) {
  const [state, dispatch] = useReducer(terminalReducer, {
    tabsByWorkspace: {},
    activeTabByWorkspace: {},
    tabsByProject: {},
    activeTabByProject: {},
  });

  // Store terminal instances in a ref to persist across re-renders
  const terminalInstancesRef = useRef<Map<string, TerminalInstance>>(new Map());

  // Store WebSocket connections in a ref to persist across component remounts
  const terminalConnectionsRef = useRef<Map<string, TerminalConnection>>(
    new Map()
  );

  // Store callback refs for each connection to prevent stale closures
  const connectionCallbacksRef = useRef<
    Map<
      string,
      {
        onData: (data: string) => void;
        onExit?: () => void;
        onSessionName?: (name: string) => void;
      }
    >
  >(new Map());

  // Store reconnection state for each connection
  const reconnectStateRef = useRef<
    Map<
      string,
      {
        endpoint: string;
        retryCount: number;
        retryTimer: ReturnType<typeof setTimeout> | null;
        intentionallyClosed: boolean;
      }
    >
  >(new Map());

  const getTabsForWorkspace = useCallback(
    (workspaceId: string): TerminalTab[] => {
      return state.tabsByWorkspace[workspaceId] || [];
    },
    [state.tabsByWorkspace]
  );

  const getActiveTab = useCallback(
    (workspaceId: string): TerminalTab | null => {
      const activeId = state.activeTabByWorkspace[workspaceId];
      if (!activeId) return null;
      const tabs = state.tabsByWorkspace[workspaceId] || [];
      return tabs.find((t) => t.id === activeId) || null;
    },
    [state.tabsByWorkspace, state.activeTabByWorkspace]
  );

  const getTabsForProject = useCallback(
    (projectId: string): TerminalTab[] => {
      return state.tabsByProject[projectId] || [];
    },
    [state.tabsByProject]
  );

  const getActiveProjectTab = useCallback(
    (projectId: string): TerminalTab | null => {
      const activeId = state.activeTabByProject[projectId];
      if (!activeId) return null;
      const tabs = state.tabsByProject[projectId] || [];
      return tabs.find((t) => t.id === activeId) || null;
    },
    [state.tabsByProject, state.activeTabByProject]
  );

  const createTab = useCallback(
    (
      workspaceId: string,
      cwd: string,
      executionProcessId?: string,
      isTui?: boolean
    ) => {
      dispatch({
        type: 'CREATE_TAB',
        workspaceId,
        cwd,
        executionProcessId,
        isTui,
      });
    },
    []
  );

  const openOrFocusTab = useCallback(
    (
      workspaceId: string,
      cwd: string,
      executionProcessId?: string,
      isTui?: boolean
    ) => {
      dispatch({
        type: 'OPEN_OR_FOCUS_TAB',
        workspaceId,
        cwd,
        executionProcessId,
        isTui,
      });
    },
    []
  );

  const closeTerminalConnection = useCallback((tabId: string) => {
    // Mark as intentionally closed to prevent reconnection
    const reconnectState = reconnectStateRef.current.get(tabId);
    if (reconnectState) {
      reconnectState.intentionallyClosed = true;
      if (reconnectState.retryTimer) {
        clearTimeout(reconnectState.retryTimer);
      }
      reconnectStateRef.current.delete(tabId);
    }

    const conn = terminalConnectionsRef.current.get(tabId);
    if (conn) {
      conn.ws.close();
      terminalConnectionsRef.current.delete(tabId);
    }
    connectionCallbacksRef.current.delete(tabId);
  }, []);

  const closeTab = useCallback(
    (workspaceId: string, tabId: string) => {
      // Dispose the terminal instance when closing the tab
      const instance = terminalInstancesRef.current.get(tabId);
      if (instance) {
        disposeTerminalInstance(instance);
        terminalInstancesRef.current.delete(tabId);
      }
      // Close the WebSocket connection
      closeTerminalConnection(tabId);
      dispatch({ type: 'CLOSE_TAB', workspaceId, tabId });
    },
    [closeTerminalConnection]
  );

  const setActiveTab = useCallback((workspaceId: string, tabId: string) => {
    dispatch({ type: 'SET_ACTIVE_TAB', workspaceId, tabId });
  }, []);

  const updateTabTitle = useCallback(
    (workspaceId: string, tabId: string, title: string) => {
      dispatch({ type: 'UPDATE_TAB_TITLE', workspaceId, tabId, title });
    },
    []
  );

  const updateTabCwd = useCallback(
    (workspaceId: string, tabId: string, cwd: string) => {
      dispatch({ type: 'UPDATE_TAB_CWD', workspaceId, tabId, cwd });
    },
    []
  );

  const setTmuxSessionName = useCallback(
    (workspaceId: string, tabId: string, tmuxSessionName: string) => {
      dispatch({
        type: 'SET_TMUX_SESSION',
        workspaceId,
        tabId,
        tmuxSessionName,
      });
    },
    []
  );

  const clearWorkspaceTabs = useCallback(
    (workspaceId: string) => {
      // Dispose all terminal instances for this workspace
      const tabs = state.tabsByWorkspace[workspaceId] || [];
      tabs.forEach((tab) => {
        const instance = terminalInstancesRef.current.get(tab.id);
        if (instance) {
          disposeTerminalInstance(instance);
          terminalInstancesRef.current.delete(tab.id);
        }
        // Close WebSocket connections
        closeTerminalConnection(tab.id);
      });
      dispatch({ type: 'CLEAR_WORKSPACE_TABS', workspaceId });
    },
    [state.tabsByWorkspace, closeTerminalConnection]
  );

  const createProjectTab = useCallback(
    (projectId: string, repoPath: string, isTui?: boolean) => {
      dispatch({ type: 'CREATE_PROJECT_TAB', projectId, repoPath, isTui });
    },
    []
  );

  const closeProjectTab = useCallback(
    (projectId: string, tabId: string) => {
      const instance = terminalInstancesRef.current.get(tabId);
      if (instance) {
        disposeTerminalInstance(instance);
        terminalInstancesRef.current.delete(tabId);
      }
      closeTerminalConnection(tabId);
      dispatch({ type: 'CLOSE_PROJECT_TAB', projectId, tabId });
    },
    [closeTerminalConnection]
  );

  const setActiveProjectTab = useCallback(
    (projectId: string, tabId: string) => {
      dispatch({ type: 'SET_ACTIVE_PROJECT_TAB', projectId, tabId });
    },
    []
  );

  const updateProjectTabTitle = useCallback(
    (projectId: string, tabId: string, title: string) => {
      dispatch({ type: 'UPDATE_PROJECT_TAB_TITLE', projectId, tabId, title });
    },
    []
  );

  const updateProjectTabCwd = useCallback(
    (projectId: string, tabId: string, cwd: string) => {
      dispatch({ type: 'UPDATE_PROJECT_TAB_CWD', projectId, tabId, cwd });
    },
    []
  );

  const setProjectTabTmuxSessionName = useCallback(
    (projectId: string, tabId: string, tmuxSessionName: string) => {
      dispatch({
        type: 'SET_PROJECT_TAB_TMUX_SESSION',
        projectId,
        tabId,
        tmuxSessionName,
      });
    },
    []
  );

  const clearProjectTabs = useCallback(
    (projectId: string) => {
      const tabs = state.tabsByProject[projectId] || [];
      tabs.forEach((tab) => {
        const instance = terminalInstancesRef.current.get(tab.id);
        if (instance) {
          disposeTerminalInstance(instance);
          terminalInstancesRef.current.delete(tab.id);
        }
        closeTerminalConnection(tab.id);
      });
      dispatch({ type: 'CLEAR_PROJECT_TABS', projectId });
    },
    [state.tabsByProject, closeTerminalConnection]
  );

  const registerTerminalInstance = useCallback(
    (tabId: string, terminal: Terminal, fitAddon: FitAddon) => {
      terminalInstancesRef.current.set(tabId, { terminal, fitAddon });
    },
    []
  );

  const getTerminalInstance = useCallback(
    (tabId: string): TerminalInstance | null => {
      return terminalInstancesRef.current.get(tabId) || null;
    },
    []
  );

  const unregisterTerminalInstance = useCallback((tabId: string) => {
    terminalInstancesRef.current.delete(tabId);
  }, []);

  // Tear down a terminal mounted outside the reducer tab list (the in-pane
  // headed terminal). Mirrors `closeTab`'s cleanup — dispose the xterm and close
  // the WebSocket — but without dispatching a CLOSE_TAB action, since this
  // terminal was never added to `tabsByWorkspace`.
  const disposeStandaloneTerminal = useCallback(
    (tabId: string) => {
      const instance = terminalInstancesRef.current.get(tabId);
      if (instance) {
        disposeTerminalInstance(instance);
        terminalInstancesRef.current.delete(tabId);
      }
      closeTerminalConnection(tabId);
    },
    [closeTerminalConnection]
  );

  const createTerminalConnection = useCallback(
    (
      tabId: string,
      endpoint: string,
      onData: (data: string) => void,
      onExit?: () => void,
      onSessionName?: (name: string) => void
    ) => {
      // Close existing connection if any
      const existing = terminalConnectionsRef.current.get(tabId);
      if (existing) {
        existing.ws.close();
      }

      // Store callbacks in ref so they can be updated without recreating connection
      connectionCallbacksRef.current.set(tabId, {
        onData,
        onExit,
        onSessionName,
      });

      // Initialize or reset reconnection state
      const existingReconnectState = reconnectStateRef.current.get(tabId);
      if (existingReconnectState?.retryTimer) {
        clearTimeout(existingReconnectState.retryTimer);
      }
      reconnectStateRef.current.set(tabId, {
        endpoint,
        retryCount: 0,
        retryTimer: null,
        intentionallyClosed: false,
      });

      const scheduleReconnect = () => {
        const state = reconnectStateRef.current.get(tabId);
        if (!state || state.intentionallyClosed) {
          return;
        }

        const maxRetries = 6;
        if (state.retryCount >= maxRetries) {
          return;
        }

        const delay = Math.min(8000, 500 * Math.pow(2, state.retryCount));
        state.retryCount += 1;
        state.retryTimer = setTimeout(() => {
          state.retryTimer = null;
          connectWebSocket();
        }, delay);
      };

      const connectWebSocket = () => {
        const reconnectState = reconnectStateRef.current.get(tabId);
        if (!reconnectState || reconnectState.intentionallyClosed) {
          return;
        }

        void (async () => {
          try {
            const ws = await openLocalApiWebSocket(endpoint);
            const state = reconnectStateRef.current.get(tabId);
            if (!state || state.intentionallyClosed) {
              ws.close();
              return;
            }

            ws.onopen = () => {
              // Reset retry count on successful connection
              const latestState = reconnectStateRef.current.get(tabId);
              if (latestState) {
                latestState.retryCount = 0;
              }
            };

            ws.onmessage = (event) => {
              try {
                const msg = JSON.parse(event.data);
                const callbacks = connectionCallbacksRef.current.get(tabId);
                if (msg.type === 'output' && msg.data && callbacks) {
                  callbacks.onData(decodeBase64(msg.data));
                } else if (msg.type === 'error' && msg.message && callbacks) {
                  // Surface server-side errors (e.g. a dead/absent tmux attach
                  // target, or the agent session ending) in the terminal. The
                  // server pairs these with a clean close (code 1000), so this
                  // is the last thing shown and no reconnect follows.
                  callbacks.onData(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
                } else if (msg.type === 'exit' && callbacks) {
                  callbacks.onExit?.();
                } else if (
                  msg.type === 'session_name' &&
                  msg.name &&
                  callbacks
                ) {
                  callbacks.onSessionName?.(msg.name);
                }
              } catch {
                // Ignore parse errors
              }
            };

            ws.onerror = () => {
              // Error will be followed by onclose, so we handle reconnection there
            };

            ws.onclose = (event) => {
              const latestState = reconnectStateRef.current.get(tabId);
              if (!latestState || latestState.intentionallyClosed) {
                return;
              }

              // Don't reconnect on clean close (code 1000) or if shell exited
              if (event.code === 1000 && event.wasClean) {
                return;
              }

              scheduleReconnect();
            };

            const send = (data: string) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({ type: 'input', data: encodeBase64(data) })
                );
              }
            };

            const resize = (cols: number, rows: number) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'resize', cols, rows }));
              }
            };

            const connection: TerminalConnection = { ws, send, resize };
            terminalConnectionsRef.current.set(tabId, connection);
          } catch {
            scheduleReconnect();
          }
        })();
      };

      connectWebSocket();

      // Return functions that use the current connection
      const send = (data: string) => {
        const conn = terminalConnectionsRef.current.get(tabId);
        conn?.send(data);
      };

      const resize = (cols: number, rows: number) => {
        const conn = terminalConnectionsRef.current.get(tabId);
        conn?.resize(cols, rows);
      };

      return { send, resize };
    },
    []
  );

  const getTerminalConnection = useCallback(
    (tabId: string): TerminalConnection | null => {
      return terminalConnectionsRef.current.get(tabId) || null;
    },
    []
  );

  const value = useMemo(
    () => ({
      getTabsForWorkspace,
      getActiveTab,
      createTab,
      openOrFocusTab,
      closeTab,
      setActiveTab,
      updateTabTitle,
      updateTabCwd,
      setTmuxSessionName,
      clearWorkspaceTabs,
      getTabsForProject,
      getActiveProjectTab,
      createProjectTab,
      closeProjectTab,
      setActiveProjectTab,
      updateProjectTabTitle,
      updateProjectTabCwd,
      setProjectTabTmuxSessionName,
      clearProjectTabs,
      registerTerminalInstance,
      getTerminalInstance,
      unregisterTerminalInstance,
      disposeStandaloneTerminal,
      createTerminalConnection,
      getTerminalConnection,
    }),
    [
      getTabsForWorkspace,
      getActiveTab,
      createTab,
      openOrFocusTab,
      closeTab,
      setActiveTab,
      updateTabTitle,
      updateTabCwd,
      setTmuxSessionName,
      clearWorkspaceTabs,
      getTabsForProject,
      getActiveProjectTab,
      createProjectTab,
      closeProjectTab,
      setActiveProjectTab,
      updateProjectTabTitle,
      updateProjectTabCwd,
      setProjectTabTmuxSessionName,
      clearProjectTabs,
      registerTerminalInstance,
      getTerminalInstance,
      unregisterTerminalInstance,
      disposeStandaloneTerminal,
      createTerminalConnection,
      getTerminalConnection,
    ]
  );

  return (
    <TerminalContext.Provider value={value}>
      {children}
    </TerminalContext.Provider>
  );
}
