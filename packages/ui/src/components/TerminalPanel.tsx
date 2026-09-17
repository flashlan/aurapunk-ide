import { useCallback } from 'react';
import type { ReactNode } from 'react';
import { PlusIcon, XIcon } from '@phosphor-icons/react';
import { cn } from '../lib/cn';

interface TerminalPanelTab {
  id: string;
  title: string;
  cwd?: string;
}

interface TerminalPanelProps {
  tabs: TerminalPanelTab[];
  activeTabId: string | null;
  renderTab: (tabId: string, isActive: boolean) => ReactNode;
  onSelectTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  onNewTab?: () => void;
  onNewTuiTab?: () => void;
  onClose?: () => void;
  title?: string;
  /** Optional content rendered at the left end of the tab bar. */
  leading?: ReactNode;
}

function shortenCwd(cwd: string): string {
  if (!cwd) return '';
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 2) return '/' + parts.join('/');
  return '~/' + parts.slice(-2).join('/');
}

export function TerminalPanel({
  tabs,
  activeTabId,
  renderTab,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onNewTuiTab,
  onClose,
  title,
  leading,
}: TerminalPanelProps) {
  const handleCloseTab = useCallback(
    (tabId: string) => {
      if (tabs.length <= 1 && onClose) {
        onClose();
        return;
      }
      onCloseTab?.(tabId);
    },
    [onCloseTab, tabs.length, onClose]
  );
  // Render only the active terminal. Inactive ones stay alive in the provider
  // (their xterm instance and WebSocket persist), so switching back re-attaches
  // the existing element rather than spawning a new session.
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;

  return (
    <div className="flex flex-col h-full min-h-0 w-full">
      {/* Top header: Project Terminal + Vibe + controls */}
      <div className="flex items-center justify-between shrink-0 border-b border-border bg-tertiary h-8 px-2">
        <div className="flex items-center gap-2 min-w-0">
          {leading ? (
            <div className="flex items-center gap-1 shrink-0">{leading}</div>
          ) : null}
          <span className="text-xs font-semibold text-normal select-none truncate">
            {title ?? 'Project Terminal'}
          </span>
          <span className="text-[10px] font-medium tracking-wide text-amber-500/90 select-none">
            Vibe
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onNewTuiTab && (
            <button
              type="button"
              title="Open Cockpit TUI (aurapunk-tui)"
              aria-label="Open Cockpit TUI"
              className="flex items-center gap-1 px-2 py-1 rounded-sm text-xs font-medium text-amber-500 hover:text-amber-400 hover:bg-secondary transition-colors cursor-pointer"
              onClick={onNewTuiTab}
            >
              <span>⚡</span>
              <span>TUI</span>
            </button>
          )}
          {onClose && (
            <button
              type="button"
              title="Close panel"
              aria-label="Close panel"
              className="flex items-center justify-center size-6 rounded-sm text-low hover:text-normal hover:bg-secondary transition-colors cursor-pointer"
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onClose();
              }}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
              }}
            >
              <XIcon
                className="size-icon-xs pointer-events-none"
                weight="bold"
              />
            </button>
          )}
        </div>
      </div>

      {tabs.length > 0 && (
        <div className="flex items-start shrink-0 border-b border-border bg-tertiary min-h-7">
          <div className="flex-1 min-w-0 overflow-x-hidden overflow-y-auto max-h-[84px]">
            <div className="flex flex-wrap items-stretch gap-px">
              {tabs.map((tab) => {
                const isActive = tab.id === activeTab?.id;
                const displayTitle = tab.cwd
                  ? `${tab.title} — ${shortenCwd(tab.cwd)}`
                  : tab.title;
                const showClose =
                  onCloseTab &&
                  (tabs.length > 1 || (tabs.length === 1 && onClose));
                return (
                  <div
                    key={tab.id}
                    className={cn(
                      'group flex items-stretch border-r border-border shrink-0 h-7',
                      isActive ? 'bg-secondary' : 'bg-tertiary'
                    )}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      className={cn(
                        'flex items-center gap-1 pl-2 pr-1 py-0.5 text-xs cursor-pointer h-full',
                        isActive ? 'text-normal' : 'text-low hover:text-normal'
                      )}
                      onClick={() => onSelectTab?.(tab.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelectTab?.(tab.id);
                        }
                      }}
                    >
                      <span className="truncate max-w-[140px]">
                        {displayTitle}
                      </span>
                    </div>
                    {showClose && (
                      <button
                        type="button"
                        title="Close terminal"
                        aria-label="Close terminal"
                        className="flex items-center justify-center w-6 px-1 text-low hover:text-normal hover:bg-secondary/70 shrink-0 h-full cursor-pointer"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          handleCloseTab(tab.id);
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                        }}
                      >
                        <XIcon
                          className="size-icon-xs pointer-events-none"
                          weight="bold"
                        />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {onNewTab && (
            <button
              type="button"
              title="New terminal"
              aria-label="New terminal"
              className="flex items-center self-start px-1.5 h-7 text-low hover:text-normal shrink-0 border-l border-border cursor-pointer"
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onNewTab();
              }}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
              }}
            >
              <PlusIcon
                className="size-icon-xs pointer-events-none"
                weight="bold"
              />
            </button>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0 w-full relative">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab?.id;
          return (
            <div
              key={tab.id}
              className={cn(
                'absolute inset-0 w-full h-full',
                isActive ? 'block' : 'hidden'
              )}
            >
              {renderTab(tab.id, isActive)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
