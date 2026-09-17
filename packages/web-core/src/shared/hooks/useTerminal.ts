import { useContext } from 'react';
import { createHmrContext } from '@/shared/lib/hmrContext';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

export interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
}

export interface TerminalTab {
  id: string;
  title: string;
  /** Workspace-scoped terminal tabs carry the workspace id. */
  workspaceId?: string;
  /** Project/repo-scoped terminal tabs carry the project id and repo path. */
  projectId?: string;
  repoPath?: string;
  cwd: string;
  /** When set, this tab is attached to the agent's tmux session (`vk-<id>`). */
  executionProcessId?: string;
  /** Persistent tmux session name for re-attachment after page reload. */
  tmuxSessionName?: string;
  /** When true, launches the aurapunk-tui cockpit. */
  isTui?: boolean;
}

export type TerminalScope =
  | { type: 'workspace'; id: string }
  | { type: 'project'; id: string };

interface TerminalConnection {
  ws: WebSocket;
  send: (data: string) => void;
  resize: (cols: number, rows: number) => void;
}

export interface TerminalContextType {
  getTabsForWorkspace: (workspaceId: string) => TerminalTab[];
  getActiveTab: (workspaceId: string) => TerminalTab | null;
  createTab: (
    workspaceId: string,
    cwd: string,
    executionProcessId?: string,
    isTui?: boolean
  ) => void;
  /**
   * Open a terminal tab, or focus an existing one. When `executionProcessId` is
   * given and a tab is already attached to that session, the existing tab is
   * activated instead of opening a duplicate (idempotent attach).
   */
  openOrFocusTab: (
    workspaceId: string,
    cwd: string,
    executionProcessId?: string,
    isTui?: boolean
  ) => void;
  closeTab: (workspaceId: string, tabId: string) => void;
  setActiveTab: (workspaceId: string, tabId: string) => void;
  updateTabTitle: (workspaceId: string, tabId: string, title: string) => void;
  updateTabCwd: (workspaceId: string, tabId: string, cwd: string) => void;
  setTmuxSessionName: (
    workspaceId: string,
    tabId: string,
    tmuxSessionName: string
  ) => void;
  clearWorkspaceTabs: (workspaceId: string) => void;
  /** Project-scoped terminal tabs. */
  getTabsForProject: (projectId: string) => TerminalTab[];
  getActiveProjectTab: (projectId: string) => TerminalTab | null;
  createProjectTab: (
    projectId: string,
    repoPath: string,
    isTui?: boolean
  ) => void;
  closeProjectTab: (projectId: string, tabId: string) => void;
  setActiveProjectTab: (projectId: string, tabId: string) => void;
  updateProjectTabTitle: (
    projectId: string,
    tabId: string,
    title: string
  ) => void;
  updateProjectTabCwd: (projectId: string, tabId: string, cwd: string) => void;
  setProjectTabTmuxSessionName: (
    projectId: string,
    tabId: string,
    tmuxSessionName: string
  ) => void;
  clearProjectTabs: (projectId: string) => void;
  registerTerminalInstance: (
    tabId: string,
    terminal: Terminal,
    fitAddon: FitAddon
  ) => void;
  getTerminalInstance: (tabId: string) => TerminalInstance | null;
  unregisterTerminalInstance: (tabId: string) => void;
  /**
   * Fully tear down a terminal that was mounted OUTSIDE the reducer tab list
   * (e.g. the in-pane headed terminal): close its WebSocket, dispose the xterm
   * instance, and unregister it. Mirrors `closeTab`'s cleanup without
   * dispatching a tab action.
   */
  disposeStandaloneTerminal: (tabId: string) => void;
  createTerminalConnection: (
    tabId: string,
    endpoint: string,
    onData: (data: string) => void,
    onExit?: () => void,
    onSessionName?: (name: string) => void
  ) => {
    send: (data: string) => void;
    resize: (cols: number, rows: number) => void;
  };
  getTerminalConnection: (tabId: string) => TerminalConnection | null;
}

export const TerminalContext = createHmrContext<TerminalContextType | null>(
  'TerminalContext',
  null
);

export function useTerminal() {
  const context = useContext(TerminalContext);
  if (!context) {
    throw new Error('useTerminal must be used within TerminalProvider');
  }
  return context;
}
