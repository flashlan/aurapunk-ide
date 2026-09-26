import { useEffect, useRef } from 'react';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useTerminal } from '@/shared/hooks/useTerminal';
import { TerminalPanel } from '@vibe/ui/components/TerminalPanel';
import { XTermInstance } from './LazyXTermInstance';

export function TerminalPanelContainer() {
  const { workspace } = useWorkspaceContext();
  const {
    getTabsForWorkspace,
    getActiveTab,
    createTab,
    closeTab,
    setActiveTab,
    updateTabCwd,
    updateTabTitle,
    setTmuxSessionName,
    clearWorkspaceTabs,
  } = useTerminal();

  const workspaceId = workspace?.id;
  const containerRef = workspace?.container_ref ?? null;
  const tabs = workspaceId ? getTabsForWorkspace(workspaceId) : [];
  const activeTab = workspaceId ? getActiveTab(workspaceId) : null;

  const creatingRef = useRef(false);
  const prevWorkspaceIdRef = useRef<string | null>(null);

  // Clean up terminals when workspace changes
  useEffect(() => {
    if (
      prevWorkspaceIdRef.current &&
      prevWorkspaceIdRef.current !== workspaceId
    ) {
      clearWorkspaceTabs(prevWorkspaceIdRef.current);
    }
    prevWorkspaceIdRef.current = workspaceId ?? null;
  }, [workspaceId, clearWorkspaceTabs]);

  // Auto-create first tab when workspace is selected and terminal mode is active
  useEffect(() => {
    if (
      workspaceId &&
      containerRef &&
      tabs.length === 0 &&
      !creatingRef.current
    ) {
      creatingRef.current = true;
      createTab(workspaceId, containerRef);
    }
    if (tabs.length > 0) {
      creatingRef.current = false;
    }
  }, [workspaceId, containerRef, tabs.length, createTab]);

  return (
    <TerminalPanel
      title="Terminal Panel"
      tabs={tabs.map((t) => ({
        id: t.id,
        title: t.title,
        cwd: t.cwd,
      }))}
      activeTabId={activeTab?.id ?? null}
      onSelectTab={(tabId) => workspaceId && setActiveTab(workspaceId, tabId)}
      onCloseTab={(tabId) => workspaceId && closeTab(workspaceId, tabId)}
      onNewTab={() => {
        if (workspaceId && containerRef) {
          createTab(workspaceId, containerRef);
        }
      }}
      onNewTuiTab={() => {
        if (workspaceId && containerRef) {
          createTab(workspaceId, containerRef, undefined, true);
        }
      }}
      renderTab={(tabId, isActive) => {
        const tab = tabs.find((t) => t.id === tabId);
        return (
          <XTermInstance
            key={tabId}
            tabId={tabId}
            workspaceId={workspaceId ?? ''}
            isActive={isActive}
            executionProcessId={tab?.executionProcessId}
            tmuxSessionName={tab?.tmuxSessionName}
            isTui={tab?.isTui}
            onClose={() => workspaceId && closeTab(workspaceId, tabId)}
            onCwdChange={(cwd) => {
              if (workspaceId) {
                updateTabCwd(workspaceId, tabId, cwd);
              }
            }}
            onTitleChange={(title) => {
              if (workspaceId) {
                updateTabTitle(workspaceId, tabId, title);
              }
            }}
            onSessionName={(name) => {
              if (workspaceId) {
                setTmuxSessionName(workspaceId, tabId, name);
              }
            }}
          />
        );
      }}
    />
  );
}
