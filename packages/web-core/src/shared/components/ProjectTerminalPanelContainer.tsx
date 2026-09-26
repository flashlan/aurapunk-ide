import { useEffect, useRef, useState } from 'react';
import { useProjectContext } from '@/shared/hooks/useProjectContext';
import { useTerminal } from '@/shared/hooks/useTerminal';
import { TerminalPanel } from '@vibe/ui/components/TerminalPanel';
import { XTermInstance } from './LazyXTermInstance';
import { repoApi } from '@/shared/lib/api';
import { getProjectRepoDefaults } from '@/shared/hooks/useProjectRepoDefaults';
import type { Repo } from 'shared/types';

interface ProjectTerminalPanelContainerProps {
  onClose?: () => void;
}

export function ProjectTerminalPanelContainer({
  onClose,
}: ProjectTerminalPanelContainerProps) {
  const { projectId } = useProjectContext();
  const {
    getTabsForProject,
    getActiveProjectTab,
    createProjectTab,
    closeProjectTab,
    setActiveProjectTab,
    updateProjectTabCwd,
    updateProjectTabTitle,
    setProjectTabTmuxSessionName,
  } = useTerminal();

  const tabs = getTabsForProject(projectId);
  const activeTab = getActiveProjectTab(projectId);

  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const creatingRef = useRef(false);

  // Load the project's default repos so we know which repo path to open.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([repoApi.list(), getProjectRepoDefaults(projectId)])
      .then(([allRepos, defaults]) => {
        if (cancelled) return;
        const defaultIds = new Set(defaults?.map((d) => d.repo_id) ?? []);
        const projectRepos = allRepos
          .filter((r) => defaultIds.has(r.id))
          .sort((a, b) => a.display_name.localeCompare(b.display_name));
        setRepos(projectRepos);
      })
      .catch((err) => {
        console.error('[ProjectTerminalPanel] failed to load repos:', err);
      })
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Auto-create the first project terminal tab when repos are loaded.
  useEffect(() => {
    const firstRepo = repos[0];
    if (firstRepo && tabs.length === 0 && !creatingRef.current && !loading) {
      creatingRef.current = true;
      createProjectTab(projectId, firstRepo.path);
    }
    if (tabs.length > 0) {
      creatingRef.current = false;
    }
  }, [projectId, repos, tabs.length, loading, createProjectTab]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <p className="text-low">Loading project terminals…</p>
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <p className="text-low">
          No repositories linked to this project. Link one in project settings.
        </p>
      </div>
    );
  }

  return (
    <TerminalPanel
      title="Project Terminal"
      tabs={tabs.map((t) => ({
        id: t.id,
        title: t.title,
        cwd: t.cwd,
      }))}
      activeTabId={activeTab?.id ?? null}
      onSelectTab={(tabId) => setActiveProjectTab(projectId, tabId)}
      onCloseTab={(tabId) => closeProjectTab(projectId, tabId)}
      onNewTab={() => {
        // Cycle through linked repos for each new tab.
        const nextRepo = repos[tabs.length % repos.length];
        createProjectTab(projectId, nextRepo.path);
      }}
      onNewTuiTab={() => {
        const firstRepo = repos[0];
        if (firstRepo) {
          createProjectTab(projectId, firstRepo.path, true);
        }
      }}
      onClose={onClose}
      renderTab={(tabId, isActive) => {
        const tab = tabs.find((t) => t.id === tabId);
        return (
          <XTermInstance
            key={tabId}
            tabId={tabId}
            repoPath={tab?.repoPath ?? ''}
            isActive={isActive}
            isTui={tab?.isTui}
            onClose={() => closeProjectTab(projectId, tabId)}
            onCwdChange={(cwd) => {
              updateProjectTabCwd(projectId, tabId, cwd);
            }}
            onTitleChange={(title) => {
              updateProjectTabTitle(projectId, tabId, title);
            }}
            onSessionName={(name) => {
              setProjectTabTmuxSessionName(projectId, tabId, name);
            }}
          />
        );
      }}
    />
  );
}
