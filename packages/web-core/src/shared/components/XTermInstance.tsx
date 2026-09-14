import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

import { useTheme } from '@/shared/hooks/useTheme';
import { getTerminalTheme } from '@/shared/lib/terminalTheme';
import { useTerminal } from '@/shared/hooks/useTerminal';
import { useTerminalPreferences } from '@/shared/stores/useTerminalPreferencesStore';
import { isTauriApp } from '@/shared/lib/platform';

interface XTermInstanceProps {
  tabId: string;
  /** Workspace-scoped terminal: connects via `workspace_id`. */
  workspaceId?: string;
  /** Project/repo-scoped terminal: connects via `repo_path`. */
  repoPath?: string;
  isActive: boolean;
  /**
   * When set, attach this terminal to the running headed agent's tmux session
   * (`vk-<executionProcessId>`) instead of opening a plain workspace shell.
   * Only valid together with `workspaceId`.
   */
  executionProcessId?: string;
  /** Persistent tmux session name for re-attachment after page reload. */
  tmuxSessionName?: string;
  isTui?: boolean;
  onClose?: () => void;
  /** Callback when the terminal reports a CWD change via OSC 7. */
  onCwdChange?: (cwd: string) => void;
  /** Callback when the terminal reports a title change via OSC 0/2. */
  onTitleChange?: (title: string) => void;
  /** Callback when the backend sends a tmux session name for persistence. */
  onSessionName?: (name: string) => void;
}

type ManagedTerminal = Terminal & { __aurapunkDisposed?: boolean };

function isDisposedTerminal(terminal: Terminal | null): boolean {
  return Boolean(terminal && (terminal as ManagedTerminal).__aurapunkDisposed);
}

export function XTermInstance({
  tabId,
  workspaceId,
  repoPath,
  isActive,
  executionProcessId,
  tmuxSessionName,
  isTui,
  onClose,
  onCwdChange,
  onTitleChange,
  onSessionName,
}: XTermInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const disposedRef = useRef(false);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const initialSizeRef = useRef({ cols: 80, rows: 24 });
  const { theme } = useTheme();
  const prefs = useTerminalPreferences();
  const {
    registerTerminalInstance,
    getTerminalInstance,
    createTerminalConnection,
    getTerminalConnection,
  } = useTerminal();

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const onSessionNameRef = useRef(onSessionName);
  onSessionNameRef.current = onSessionName;

  const endpoint = useMemo(() => {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const host = window.location.host;
    const params = new URLSearchParams({
      cols: String(initialSizeRef.current.cols),
      rows: String(initialSizeRef.current.rows),
    });
    if (workspaceId) {
      params.set('workspace_id', workspaceId);
    } else if (repoPath) {
      params.set('repo_path', repoPath);
    }
    if (executionProcessId) {
      params.set('execution_process_id', executionProcessId);
    }
    if (tmuxSessionName) {
      params.set('tmux_session', tmuxSessionName);
    }
    if (isTui) {
      params.set('is_tui', 'true');
    }
    return `${protocol}//${host}/api/terminal/ws?${params.toString()}`;
  }, [workspaceId, repoPath, executionProcessId, tmuxSessionName, isTui]);

  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;

  const fitTerminal = useCallback(() => {
    if (disposedRef.current) return;

    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon || isDisposedTerminal(terminal)) return;

    try {
      fitAddon.fit();
      if (!disposedRef.current && !isDisposedTerminal(terminal)) {
        getTerminalConnection(tabId)?.resize(terminal.cols, terminal.rows);
      }
    } catch {
      // A provider-level close can race a ResizeObserver callback. xterm's
      // private core is no longer usable in that case; the next mount creates
      // a fresh instance.
    }
  }, [tabId, getTerminalConnection]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    disposedRef.current = false;

    // A single xterm instance per tab is shared between the in-sidebar terminal
    // and the expanded (full-pane) terminal: only one is mounted at a time, and
    // we move the terminal's DOM element into whichever container is live.
    const existing = getTerminalInstance(tabId);
    let terminal: Terminal;
    let fitAddon: FitAddon;

    if (existing && !isDisposedTerminal(existing.terminal)) {
      terminal = existing.terminal;
      fitAddon = existing.fitAddon;
      if (terminal.element && terminal.element.parentNode !== container) {
        container.appendChild(terminal.element);
      }
    } else {
      terminal = new Terminal({
        cursorBlink: true,
        fontSize: prefs.fontSize,
        fontFamily: prefs.fontFamily,
        fontWeight: prefs.fontWeight,
        fontWeightBold: prefs.fontWeightBold,
        lineHeight: prefs.lineHeight,
        letterSpacing: prefs.letterSpacing,
        scrollback: prefs.scrollback,
        theme: getTerminalTheme(),
        allowProposedApi: true,
      });

      fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      const searchAddon = new SearchAddon();
      const unicodeAddon = new Unicode11Addon();

      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.loadAddon(searchAddon);
      terminal.loadAddon(unicodeAddon);

      // Try WebGL renderer for better performance, fall back to canvas
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
        });
        terminal.loadAddon(webglAddon);
      } catch {
        // WebGL not available, canvas renderer is fine
      }

      terminal.unicode.activeVersion = '11';

      terminal.open(container);

      fitAddon.fit();
      initialSizeRef.current = { cols: terminal.cols, rows: terminal.rows };

      if (!getTerminalConnection(tabId)) {
        createTerminalConnection(
          tabId,
          endpointRef.current,
          (data) => {
            if (!disposedRef.current && !isDisposedTerminal(terminal)) {
              terminal.write(data);
            }
          },
          () => onCloseRef.current?.(),
          (name) => onSessionNameRef.current?.(name)
        );
      }

      registerTerminalInstance(tabId, terminal, fitAddon);

      terminal.onData((data) => {
        const conn = getTerminalConnection(tabId);
        conn?.send(data);
      });

      // Track CWD changes via OSC 7: \x1b]7;file://host/path\x07
      terminal.parser.registerOscHandler(7, (data) => {
        if (data.startsWith('file://')) {
          const url = data.replace('file://', '');
          const path = decodeURIComponent(url.replace(/^[^/]+/, ''));
          onCwdChangeRef.current?.(path);
        }
        return true;
      });

      // Track title changes via OSC 0 and OSC 2
      const handleTitle = (title: string) => {
        if (title) {
          onTitleChangeRef.current?.(title);
        }
      };
      terminal.parser.registerOscHandler(0, (data) => {
        handleTitle(data);
        return true;
      });
      terminal.parser.registerOscHandler(2, (data) => {
        handleTitle(data);
        return true;
      });

      searchAddonRef.current = searchAddon;
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Re-fit and force a repaint on the next frame: a moved element keeps its
    // buffer, but the xterm renderer stays blank until it is refreshed, and the
    // new container's size may differ. Also re-sync the PTY size to the client.
    const raf = requestAnimationFrame(() => {
      if (disposedRef.current || isDisposedTerminal(terminal)) return;

      try {
        fitAddon.fit();
        if (disposedRef.current || isDisposedTerminal(terminal)) return;
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
        getTerminalConnection(tabId)?.resize(terminal.cols, terminal.rows);
        if (isActive && !disposedRef.current) {
          terminal.focus();
        }
      } catch {
        // The terminal may have been disposed between the guard and xterm's
        // internal renderer call. Ignore that expected close race.
      }
    });

    return () => {
      disposedRef.current = true;
      cancelAnimationFrame(raf);
      // Only detach the element if it still lives in THIS container — never
      // steal it from another container that may have re-parented it (e.g.
      // when switching between the sidebar and expanded terminal views).
      const el = terminal.element;
      if (el && el.parentNode === container) {
        container.removeChild(el);
      }
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [
    tabId,
    isActive,
    getTerminalInstance,
    registerTerminalInstance,
    createTerminalConnection,
    getTerminalConnection,
    prefs.fontSize,
    prefs.fontFamily,
    prefs.fontWeight,
    prefs.fontWeightBold,
    prefs.lineHeight,
    prefs.letterSpacing,
    prefs.scrollback,
  ]);

  useEffect(() => {
    if (!resizeRef.current) return;
    const observer = new ResizeObserver(fitTerminal);
    observer.observe(resizeRef.current);
    return () => observer.disconnect();
  }, [fitTerminal]);

  useEffect(() => {
    if (isActive) {
      fitTerminal();
      terminalRef.current?.focus();
    }
  }, [isActive, fitTerminal]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getTerminalTheme();
    }
  }, [theme]);

  // Expose search for external Ctrl+F trigger
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && isActive) {
        e.preventDefault();
        searchAddonRef.current?.findNext('');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isActive]);

  // Drag-and-drop support for files/images
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      dragCounterRef.current = 0;

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      const terminal = terminalRef.current;
      const conn = getTerminalConnection(tabId);
      if (!terminal || !conn) return;

      // Try to get file paths from Tauri's file drop event
      if (isTauriApp()) {
        // In Tauri, we can get the full paths from the native event
        // The Tauri file drop handler provides paths, but we need to
        // fall back to file names if not available
        for (const file of files) {
          const path = file.name; // Fallback to name
          conn.send(`"${path}" `);
        }
      } else {
        // In browser, insert file names (quoted for paths with spaces)
        for (const file of files) {
          const name = file.name;
          conn.send(`"${name}" `);
        }
      }

      terminal.focus();
    },
    [tabId, getTerminalConnection]
  );

  // Tauri native file drop support
  useEffect(() => {
    if (!isTauriApp()) return;

    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        // Access Tauri API via window.__TAURI__ at runtime
        const appWindow = (
          window as any
        ).__TAURI__?.window?.getCurrentWebviewWindow?.();
        if (!appWindow?.onDragDropEvent) return;

        unlisten = await appWindow.onDragDropEvent(
          (event: { payload: { type: string; paths: string[] } }) => {
            if (event.payload.type === 'drop') {
              const paths = event.payload.paths;
              const conn = getTerminalConnection(tabId);
              const terminal = terminalRef.current;
              if (!conn || !terminal) return;

              for (const path of paths) {
                conn.send(`"${path}" `);
              }
              terminal.focus();
            }
          }
        );
      } catch {
        // Not in Tauri or API not available
      }
    })();

    return () => {
      unlisten?.();
    };
  }, [tabId, getTerminalConnection]);

  return (
    <div
      ref={resizeRef}
      className="relative w-full h-full px-2 py-1 cursor-text"
      onClick={() => terminalRef.current?.focus()}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div ref={containerRef} className="w-full h-full" />
      {isDragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-brand/10 border-2 border-dashed border-brand rounded-sm pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-brand">
            <svg
              className="size-8"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            <span className="text-sm font-medium">Drop files here</span>
          </div>
        </div>
      )}
    </div>
  );
}
