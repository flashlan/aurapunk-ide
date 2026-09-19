import { useCallback, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { RepoAction } from '@vibe/ui/components/RepoCard';
import type { IssuePriority } from 'shared/remote-types';

export const RIGHT_MAIN_PANEL_MODES = {
  CHANGES: 'changes',
  LOGS: 'logs',
  PREVIEW: 'preview',
  MIRROR: 'mirror',
  TERMINAL: 'terminal',
} as const;

/**
 * The signed-in AuraPunk Cloud device token (format `ap_...`), persisted by the
 * desktop auth flow. The hosted memory/Laya gateway authenticates every request
 * with it, so the browser compactor needs it as a bearer for Cloud Laya calls.
 */
export function readCloudAccessToken(): string | null {
  try {
    const raw = window.localStorage.getItem('aurapunk-cloud-account');
    if (!raw) return null;
    const account = JSON.parse(raw) as { accessToken?: string };
    return account.accessToken ?? null;
  } catch {
    return null;
  }
}

export type RightMainPanelMode =
  (typeof RIGHT_MAIN_PANEL_MODES)[keyof typeof RIGHT_MAIN_PANEL_MODES];

export type LayoutMode = 'workspaces' | 'kanban';

export type MobileTab =
  | 'workspaces'
  | 'chat'
  | 'changes'
  | 'logs'
  | 'preview'
  | 'mirror'
  | 'git';

export type MobileFontScale = 'default' | 'small' | 'smaller';
export const DEFAULT_CREATE_DRAFT_WORKSPACE_BY_DEFAULT = false;

const MOBILE_FONT_SCALE_KEY = 'vk-mobile-font-scale';

const loadMobileFontScale = (): MobileFontScale => {
  try {
    const stored = localStorage.getItem(MOBILE_FONT_SCALE_KEY);
    if (stored === 'small' || stored === 'smaller') return stored;
  } catch {
    // localStorage may be unavailable
  }
  return 'default';
};

export type UiFontFamily =
  | 'ibm-plex-sans'
  | 'inter'
  | 'geist-sans'
  | 'fira-sans'
  | 'plus-jakarta-sans'
  | 'roboto'
  | 'system';
export const DEFAULT_UI_FONT_FAMILY: UiFontFamily = 'ibm-plex-sans';
const UI_FONT_FAMILY_KEY = 'vk-ui-font-family';

const loadUiFontFamily = (): UiFontFamily => {
  try {
    const stored = localStorage.getItem(UI_FONT_FAMILY_KEY);
    if (stored) return stored as UiFontFamily;
  } catch {}
  return DEFAULT_UI_FONT_FAMILY;
};

export type CodeFontFamily =
  | 'ibm-plex-mono'
  | 'jetbrains-mono'
  | 'fira-code'
  | 'geist-mono'
  | 'source-code-pro'
  | 'system-mono';
export const DEFAULT_CODE_FONT_FAMILY: CodeFontFamily = 'ibm-plex-mono';
const CODE_FONT_FAMILY_KEY = 'vk-code-font-family';

const loadCodeFontFamily = (): CodeFontFamily => {
  try {
    const stored = localStorage.getItem(CODE_FONT_FAMILY_KEY);
    if (stored) return stored as CodeFontFamily;
  } catch {}
  return DEFAULT_CODE_FONT_FAMILY;
};

export type UiFontScale = '85' | '92' | '100' | '110' | '120';
export const DEFAULT_UI_FONT_SCALE: UiFontScale = '100';
const UI_FONT_SCALE_KEY = 'vk-ui-font-scale';

const loadUiFontScale = (): UiFontScale => {
  try {
    const stored = localStorage.getItem(UI_FONT_SCALE_KEY);
    if (stored) return stored as UiFontScale;
  } catch {}
  return DEFAULT_UI_FONT_SCALE;
};

export type CodeFontSize = 11 | 12 | 13 | 14 | 15 | 16;
export const DEFAULT_CODE_FONT_SIZE: CodeFontSize = 13;
const CODE_FONT_SIZE_KEY = 'vk-code-font-size';

const loadCodeFontSize = (): CodeFontSize => {
  try {
    const stored = localStorage.getItem(CODE_FONT_SIZE_KEY);
    if (stored) {
      const n = Number(stored);
      if (n >= 11 && n <= 16) return n as CodeFontSize;
    }
  } catch {}
  return DEFAULT_CODE_FONT_SIZE;
};

export interface CustomThemeConfig {
  name: string;
  canvasBg: string;
  surfaceBg: string;
  textColor: string;
  textMutedColor: string;
  borderColor?: string;
  highlightColor: string;
  enableGradient: boolean;
  gradientColor1: string;
  gradientColor2: string;
  gradientAngle: number;
}

export const DEFAULT_CUSTOM_THEME: CustomThemeConfig = {
  name: 'Default Aurapunk',
  canvasBg: '#0f0f11',
  surfaceBg: '#18181b',
  textColor: '#f4f4f5',
  textMutedColor: '#a1a1aa',
  borderColor: '#27272a',
  highlightColor: '#f97316',
  enableGradient: false,
  gradientColor1: '#f97316',
  gradientColor2: '#ec4899',
  gradientAngle: 135,
};

const CUSTOM_THEME_KEY = 'vk-custom-theme';
const CUSTOM_THEME_ENABLED_KEY = 'vk-custom-theme-enabled';
const SAVED_CUSTOM_THEMES_KEY = 'vk-saved-custom-themes';

const loadCustomTheme = (): CustomThemeConfig => {
  try {
    const stored = localStorage.getItem(CUSTOM_THEME_KEY);
    if (stored) return { ...DEFAULT_CUSTOM_THEME, ...JSON.parse(stored) };
  } catch {}
  return DEFAULT_CUSTOM_THEME;
};

/**
 * Tauri/WebView storage can be recreated when the packaged app origin changes.
 * The scratch record is therefore a fallback, but an explicitly saved local
 * theme must win over an older server snapshot for this machine.
 */
export function hasStoredCustomTheme(): boolean {
  try {
    return localStorage.getItem(CUSTOM_THEME_KEY) !== null;
  } catch {
    return false;
  }
}

const loadCustomThemeEnabled = (): boolean => {
  try {
    const stored = localStorage.getItem(CUSTOM_THEME_ENABLED_KEY);
    // The legacy enable/disable switch was removed. Custom palettes are now
    // the only theme system and are always active.
    if (stored !== null) return true;
  } catch {}
  return true;
};

const loadSavedCustomThemes = (): CustomThemeConfig[] => {
  try {
    const stored = localStorage.getItem(SAVED_CUSTOM_THEMES_KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  return [];
};

// Persisted default pipeline id (single-select). Remembered so the next issue
// created starts on the operator's last-chosen pipeline.
const DEFAULT_PIPELINE_KEY = 'vk-default-pipeline';

const loadDefaultPipelineId = (): string | null => {
  try {
    const stored = localStorage.getItem(DEFAULT_PIPELINE_KEY);
    if (stored) return stored;
  } catch {
    // localStorage may be unavailable
  }
  return null;
};

// Persisted auto-compaction threshold ('50' | '65' | '75' | '85' | '95' | 'full').
export type CompactionThreshold = '50' | '65' | '75' | '85' | '95' | 'full';
export const DEFAULT_COMPACTION_THRESHOLD: CompactionThreshold = '85';
const COMPACTION_THRESHOLD_KEY = 'vk-compaction-threshold';

const loadCompactionThreshold = (): CompactionThreshold => {
  try {
    const stored = localStorage.getItem(COMPACTION_THRESHOLD_KEY);
    if (
      stored === '50' ||
      stored === '65' ||
      stored === '75' ||
      stored === '85' ||
      stored === '95' ||
      stored === 'full'
    ) {
      return stored;
    }
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_COMPACTION_THRESHOLD;
};

// Persisted compactor engine ('auto' | 'laya' | 'jev' | 'disabled')
export type CompactorEngineType = 'auto' | 'laya' | 'jev' | 'disabled';
export const DEFAULT_COMPACTOR_ENGINE: CompactorEngineType = 'auto';
const COMPACTOR_ENGINE_KEY = 'vk-compactor-engine';

const loadCompactorEngine = (): CompactorEngineType => {
  try {
    const stored = localStorage.getItem(COMPACTOR_ENGINE_KEY);
    if (
      stored === 'auto' ||
      stored === 'laya' ||
      stored === 'jev' ||
      stored === 'disabled'
    ) {
      return stored;
    }
  } catch {}
  return DEFAULT_COMPACTOR_ENGINE;
};

// Persisted Laya execution mode ('docker' | 'cloud'). Laya runs only as a
// managed service: either the self-hosted Docker container or the hosted
// AuraPunk Cloud gateway. The old in-process 'embedded' heuristics are no
// longer selectable.
export type LayaExecutionMode = 'docker' | 'cloud';
export const DEFAULT_LAYA_MODE: LayaExecutionMode = 'docker';
const LAYA_MODE_KEY = 'vk-laya-mode';

const loadLayaMode = (): LayaExecutionMode => {
  try {
    const stored = localStorage.getItem(LAYA_MODE_KEY);
    if (stored === 'docker' || stored === 'cloud') {
      return stored;
    }
    // Legacy 'embedded' (and anything else) migrates to the Docker default.
  } catch {}
  return DEFAULT_LAYA_MODE;
};

// Persisted Laya Docker URL
export const DEFAULT_LAYA_DOCKER_URL = 'http://localhost:8080';
const LAYA_DOCKER_URL_KEY = 'vk-laya-docker-url';

const loadLayaDockerUrl = (): string => {
  try {
    const stored = localStorage.getItem(LAYA_DOCKER_URL_KEY);
    if (stored) return stored;
  } catch {}
  return DEFAULT_LAYA_DOCKER_URL;
};

// Persisted Laya Cloud URL (the hosted AuraPunk Cloud gateway)
export const DEFAULT_LAYA_CLOUD_URL = 'https://aurapunk.dev/api/memory/v1';
const LAYA_CLOUD_URL_KEY = 'vk-laya-cloud-url';

const loadLayaCloudUrl = (): string => {
  try {
    const stored = localStorage.getItem(LAYA_CLOUD_URL_KEY);
    if (stored) return stored;
  } catch {}
  return DEFAULT_LAYA_CLOUD_URL;
};

// Persisted Jev API Key
const JEV_API_KEY_STORAGE_KEY = 'vk-jev-api-key';

const loadJevApiKey = (): string => {
  try {
    const stored = localStorage.getItem(JEV_API_KEY_STORAGE_KEY);
    if (stored) return stored;
  } catch {}
  return '';
};

// Persisted official TypeSafe (Jev) API endpoint. Jev is TypeSafe-only.
export const DEFAULT_JEV_TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_TYPESAFE_URL_KEY = 'vk-jev-typesafe-url';

const loadJevTypesafeUrl = (): string => {
  try {
    const stored = localStorage.getItem(JEV_TYPESAFE_URL_KEY);
    if (stored) return stored;
  } catch {}
  return DEFAULT_JEV_TYPESAFE_URL;
};

// Persisted Laya Guardrails Enabled
const LAYA_GUARDRAILS_ENABLED_KEY = 'vk-laya-guardrails-enabled';

const loadLayaGuardrailsEnabled = (): boolean => {
  try {
    const stored = localStorage.getItem(LAYA_GUARDRAILS_ENABLED_KEY);
    if (stored !== null) return stored === 'true';
  } catch {}
  return true;
};

// Persisted Abide Guardrails
export type AbideGuardrailsEngine = 'laya' | 'jev' | 'adaptive';
export type AbideGuardrailsAction = 'block' | 'warn';

const ABIDE_GUARDRAILS_ENABLED_KEY = 'vk-abide-guardrails-enabled';
const ABIDE_GUARDRAILS_ENGINE_KEY = 'vk-abide-guardrails-engine';
const ABIDE_GUARDRAILS_ACTION_KEY = 'vk-abide-guardrails-action';

const loadAbideGuardrailsEnabled = (): boolean => {
  try {
    const stored = localStorage.getItem(ABIDE_GUARDRAILS_ENABLED_KEY);
    if (stored !== null) return stored === 'true';
  } catch {}
  return true;
};

const loadAbideGuardrailsEngine = (): AbideGuardrailsEngine => {
  try {
    const stored = localStorage.getItem(ABIDE_GUARDRAILS_ENGINE_KEY);
    if (stored === 'laya' || stored === 'jev' || stored === 'adaptive')
      return stored;
  } catch {}
  return 'adaptive';
};

const loadAbideGuardrailsAction = (): AbideGuardrailsAction => {
  try {
    const stored = localStorage.getItem(ABIDE_GUARDRAILS_ACTION_KEY);
    if (stored === 'block' || stored === 'warn') return stored;
  } catch {}
  return 'block';
};

// Feature Checkbox Keys for Specific Guardrails
const GUARDRAIL_PROTECTED_FILES_KEY = 'vk-guardrail-protected-files';
const GUARDRAIL_AI_ATTRIBUTION_KEY = 'vk-guardrail-ai-attribution';
const GUARDRAIL_SECRET_LEAK_KEY = 'vk-guardrail-secret-leak';
const GUARDRAIL_GIT_OPS_KEY = 'vk-guardrail-git-ops';
const GUARDRAIL_SEMANTIC_JEV_KEY = 'vk-guardrail-semantic-jev';

const loadBoolPref = (key: string, defaultValue = true): boolean => {
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null) return stored === 'true';
  } catch {}
  return defaultValue;
};

// Combined pipeline selection (pipeline id + ticked stage ids), so a card
// created with "Quick + memory on" re-opens the same way next time. Stored as
// JSON `{ "id": "quick", "enabledIds": ["memory", "implement", ...] }`.
const PIPELINE_SELECTION_KEY = 'vk-pipeline-selection';

export interface PipelineSelectionPref {
  id: string | null;
  enabledIds: string[];
}

const loadPipelineSelectionPref = (): PipelineSelectionPref => {
  try {
    const stored = localStorage.getItem(PIPELINE_SELECTION_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as {
        id?: string | null;
        enabledIds?: unknown;
      };
      return {
        id: parsed.id ?? null,
        enabledIds: Array.isArray(parsed.enabledIds)
          ? parsed.enabledIds.filter((v): v is string => typeof v === 'string')
          : [],
      };
    }
  } catch {
    // localStorage may be unavailable or malformed
  }
  // Fall back to the legacy single-key preference.
  return { id: loadDefaultPipelineId(), enabledIds: [] };
};

const savePipelineSelectionPref = (pref: PipelineSelectionPref): void => {
  try {
    localStorage.setItem(PIPELINE_SELECTION_KEY, JSON.stringify(pref));
  } catch {
    // localStorage may be unavailable
  }
};

// Per-workspace custom colors ("workspace settings → color"). Stored as
// `{ [workspaceId]: hsl-triple }`; deleting a workspace's entry (value null)
// falls back to the project tint.
const WORKSPACE_COLORS_KEY = 'vk-workspace-colors';

const loadWorkspaceColors = (): Record<string, string> => {
  try {
    const stored = localStorage.getItem(WORKSPACE_COLORS_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );
  } catch {
    // localStorage may be unavailable or malformed
    return {};
  }
};

const saveWorkspaceColors = (colors: Record<string, string>): void => {
  try {
    localStorage.setItem(WORKSPACE_COLORS_KEY, JSON.stringify(colors));
  } catch {
    // localStorage may be unavailable
  }
};

const WORKSPACE_COLORS_LIMIT = 500;

// Left sidebar width (global, for any workspace, persists across reloads)
const LEFT_SIDEBAR_WIDTH_KEY = 'vk-left-sidebar-width';
export const DEFAULT_LEFT_SIDEBAR_WIDTH = 256;
export const MIN_LEFT_SIDEBAR_WIDTH = 180;
export const MAX_LEFT_SIDEBAR_WIDTH = 480;

export const clampLeftSidebarWidth = (v: number): number =>
  Math.min(
    MAX_LEFT_SIDEBAR_WIDTH,
    Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.round(v))
  );

const loadLeftSidebarWidth = (): number => {
  try {
    const stored = localStorage.getItem(LEFT_SIDEBAR_WIDTH_KEY);
    if (stored !== null) {
      const n = Number(stored);
      if (Number.isFinite(n)) return clampLeftSidebarWidth(n);
    }
  } catch {
    // localStorage may be unavailable
  }
  return DEFAULT_LEFT_SIDEBAR_WIDTH;
};

const saveLeftSidebarWidth = (w: number): void => {
  try {
    localStorage.setItem(
      LEFT_SIDEBAR_WIDTH_KEY,
      String(clampLeftSidebarWidth(w))
    );
  } catch {
    // localStorage may be unavailable
  }
};

// Animated (shimmering) border around the message box while the workspace is
// working. A subtle pulsating dot always shows; this toggles the border on top.
const ANIMATE_RUNNING_OUTLINE_KEY = 'vk-animate-running-outline';

const loadAnimateRunningOutline = (): boolean => {
  try {
    const stored = localStorage.getItem(ANIMATE_RUNNING_OUTLINE_KEY);
    if (stored !== null) return stored !== 'false';
  } catch {
    // localStorage may be unavailable
  }
  return true;
};

// Global thinking visibility. Controls whether every reasoning/thinking block in
// the chat is expanded (visible) or collapsed. Individual blocks can still be
// toggled on their own; the header button flips this global preference and
// applies it to all blocks at once.
const THINKING_EXPANDED_KEY = 'vk-thinking-expanded';

const loadThinkingExpanded = (): boolean => {
  try {
    const stored = localStorage.getItem(THINKING_EXPANDED_KEY);
    if (stored !== null) return stored !== 'false';
  } catch {
    // localStorage may be unavailable
  }
  return true;
};

// Persisted pane sizes (fallback to localStorage for instant hydration)
const PANE_SIZES_KEY = 'vk-pane-sizes';

const loadLocalPaneSizes = (): Record<string, number | string> => {
  try {
    const stored = localStorage.getItem(PANE_SIZES_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    // localStorage may be unavailable
  }
  return {};
};

const saveLocalPaneSize = (key: string, size: number | string): void => {
  try {
    const current = loadLocalPaneSizes();
    current[key] = size;
    localStorage.setItem(PANE_SIZES_KEY, JSON.stringify(current));
  } catch {
    // localStorage may be unavailable
  }
};

// Last visited workspace — restored on next app launch (via RootRedirectPage)
// and updated whenever a workspace route is entered. Client-side only
// (localStorage), mirroring the workspaceColors pattern.
const LAST_WORKSPACE_KEY = 'vk-last-workspace-id';

const loadLastWorkspaceId = (): string | null => {
  try {
    const stored = localStorage.getItem(LAST_WORKSPACE_KEY);
    if (stored) return stored;
  } catch {
    // localStorage may be unavailable
  }
  return null;
};

export type KanbanViewMode = 'kanban' | 'list';

export type ContextBarPosition =
  | 'top-left'
  | 'top-right'
  | 'middle-left'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-right';

// Workspace-specific panel state
export type WorkspacePanelState = {
  rightMainPanelMode: RightMainPanelMode | null;
  isLeftMainPanelVisible: boolean;
};

const DEFAULT_WORKSPACE_PANEL_STATE: WorkspacePanelState = {
  rightMainPanelMode: null,
  isLeftMainPanelVisible: true,
};

// Kanban filter state
export type KanbanSortField =
  | 'sort_order'
  | 'priority'
  | 'created_at'
  | 'updated_at'
  | 'title';

export type KanbanFilterState = {
  searchQuery: string;
  priorities: IssuePriority[];
  tagIds: string[];
  sortField: KanbanSortField;
  sortDirection: 'asc' | 'desc';
};

export const DEFAULT_KANBAN_FILTER_STATE: KanbanFilterState = {
  searchQuery: '',
  priorities: [],
  tagIds: [],
  sortField: 'sort_order',
  sortDirection: 'asc',
};

export const KANBAN_PROJECT_VIEW_IDS = {
  TEAM: 'team',
  PERSONAL: 'personal',
} as const;

export const DEFAULT_KANBAN_PROJECT_VIEW_ID = KANBAN_PROJECT_VIEW_IDS.TEAM;
export const DEFAULT_KANBAN_SHOW_WORKSPACES = true;
export const DEFAULT_KANBAN_HIDE_BLOCKED = false;

export const getDefaultShowSubIssuesForView = (viewId: string): boolean =>
  viewId === KANBAN_PROJECT_VIEW_IDS.PERSONAL;

export type KanbanProjectView = {
  id: string;
  name: string;
  filters: KanbanFilterState;
  showSubIssues: boolean;
  showWorkspaces: boolean;
  hideBlocked: boolean;
};

export type KanbanProjectViewSelection = {
  activeViewId: string;
};

export type KanbanProjectViewPreferences = {
  filters: KanbanFilterState;
  showSubIssues: boolean;
  showWorkspaces: boolean;
  hideBlocked: boolean;
};

export type ResolvedKanbanProjectState = {
  activeViewId: string;
  filters: KanbanFilterState;
  showSubIssues: boolean;
  showWorkspaces: boolean;
  hideBlocked: boolean;
};

const cloneKanbanFilters = (filters: KanbanFilterState): KanbanFilterState => ({
  searchQuery: filters.searchQuery,
  priorities: [...filters.priorities],
  tagIds: [...filters.tagIds],
  sortField: filters.sortField,
  sortDirection: filters.sortDirection,
});

const isKanbanProjectViewId = (
  viewId: string
): viewId is (typeof KANBAN_PROJECT_VIEW_IDS)[keyof typeof KANBAN_PROJECT_VIEW_IDS] =>
  viewId === KANBAN_PROJECT_VIEW_IDS.TEAM ||
  viewId === KANBAN_PROJECT_VIEW_IDS.PERSONAL;

const getKanbanDefaultView = (viewId: string): KanbanProjectView => {
  if (viewId === KANBAN_PROJECT_VIEW_IDS.PERSONAL) {
    return {
      id: KANBAN_PROJECT_VIEW_IDS.PERSONAL,
      name: 'Personal',
      filters: {
        ...cloneKanbanFilters(DEFAULT_KANBAN_FILTER_STATE),
        sortField: 'priority',
        sortDirection: 'asc',
      },
      showSubIssues: getDefaultShowSubIssuesForView(
        KANBAN_PROJECT_VIEW_IDS.PERSONAL
      ),
      showWorkspaces: DEFAULT_KANBAN_SHOW_WORKSPACES,
      hideBlocked: DEFAULT_KANBAN_HIDE_BLOCKED,
    };
  }

  return {
    id: KANBAN_PROJECT_VIEW_IDS.TEAM,
    name: 'Team',
    filters: cloneKanbanFilters(DEFAULT_KANBAN_FILTER_STATE),
    showSubIssues: getDefaultShowSubIssuesForView(KANBAN_PROJECT_VIEW_IDS.TEAM),
    showWorkspaces: DEFAULT_KANBAN_SHOW_WORKSPACES,
    hideBlocked: DEFAULT_KANBAN_HIDE_BLOCKED,
  };
};

const createDefaultKanbanProjectViewPreferences = (
  viewId: string
): KanbanProjectViewPreferences => {
  const view = getKanbanDefaultView(viewId);
  return {
    filters: cloneKanbanFilters(view.filters),
    showSubIssues: view.showSubIssues,
    showWorkspaces: view.showWorkspaces,
    hideBlocked: view.hideBlocked,
  };
};

export const resolveKanbanProjectState = (
  projectSelection: KanbanProjectViewSelection | undefined
): ResolvedKanbanProjectState => {
  const requestedViewId = projectSelection?.activeViewId;
  const activeViewId = isKanbanProjectViewId(requestedViewId ?? '')
    ? (requestedViewId ?? DEFAULT_KANBAN_PROJECT_VIEW_ID)
    : DEFAULT_KANBAN_PROJECT_VIEW_ID;
  const activeView = getKanbanDefaultView(activeViewId);

  return {
    activeViewId,
    filters: cloneKanbanFilters(activeView.filters),
    showSubIssues: activeView.showSubIssues,
    showWorkspaces: activeView.showWorkspaces,
    hideBlocked: activeView.hideBlocked,
  };
};

// Centralized persist keys for type safety
export const PERSIST_KEYS = {
  // Right panel sections
  gitAdvancedSettings: 'git-advanced-settings',
  gitPanelRepositories: 'git-panel-repositories',
  gitPanelProject: 'git-panel-project',
  gitPanelAddRepositories: 'git-panel-add-repositories',
  rightPanelprocesses: 'right-panel-processes',
  rightPanelPreview: 'right-panel-preview',
  rightPanelMirror: 'right-panel-mirror',
  // Process panel sections
  processesSection: 'processes-section',
  // Changes panel sections
  changesSection: 'changes-section',
  // Preview panel sections
  devServerSection: 'dev-server-section',
  // Mirror panel section
  mirrorSection: 'mirror-section',
  // Terminal panel section
  terminalSection: 'terminal-section',
  // Notes panel section
  notesSection: 'notes-section',
  // Headed session pane section
  sessionSection: 'session-section',
  // GitHub comments toggle
  showGitHubComments: 'show-github-comments',
  // Panel sizes
  rightMainPanel: 'right-main-panel',
  kanbanLeftPanel: 'kanban-left-panel',
  // Kanban issue panel sections
  kanbanIssueSubIssues: 'kanban-issue-sub-issues',
  kanbanIssueRelationships: 'kanban-issue-relationships',
  kanbanIssueAttachments: 'kanban-issue-attachments',
  kanbanIssuePipeline: 'kanban-issue-pipeline',
  // Dynamic keys (use helper functions)
  repoCard: (repoId: string) => `repo-card-${repoId}` as const,
} as const;

// Check if screen is wide enough to keep sidebar visible
const isWideScreen = () => window.innerWidth > 2048;

export type PersistKey =
  | typeof PERSIST_KEYS.gitAdvancedSettings
  | typeof PERSIST_KEYS.gitPanelRepositories
  | typeof PERSIST_KEYS.gitPanelProject
  | typeof PERSIST_KEYS.gitPanelAddRepositories
  | typeof PERSIST_KEYS.processesSection
  | typeof PERSIST_KEYS.changesSection
  | typeof PERSIST_KEYS.devServerSection
  | typeof PERSIST_KEYS.terminalSection
  | typeof PERSIST_KEYS.notesSection
  | typeof PERSIST_KEYS.sessionSection
  | typeof PERSIST_KEYS.showGitHubComments
  | typeof PERSIST_KEYS.rightMainPanel
  | typeof PERSIST_KEYS.rightPanelprocesses
  | typeof PERSIST_KEYS.rightPanelPreview
  | typeof PERSIST_KEYS.rightPanelMirror
  | typeof PERSIST_KEYS.mirrorSection
  | typeof PERSIST_KEYS.kanbanLeftPanel
  | typeof PERSIST_KEYS.kanbanIssueSubIssues
  | typeof PERSIST_KEYS.kanbanIssueRelationships
  | typeof PERSIST_KEYS.kanbanIssueAttachments
  | typeof PERSIST_KEYS.kanbanIssuePipeline
  | `repo-card-${string}`
  | `diff:${string}`
  | `edit:${string}`
  | `plan:${string}`
  | `tool:${string}`
  | `todo:${string}`
  | `subagent:${string}`
  | `user:${string}`
  | `system:${string}`
  | `thinking:${string}`
  | `compaction:${string}`
  | `error:${string}`
  | `entry:${string}`
  | `list-section-${string}`;

type State = {
  // UI preferences
  repoActions: Record<string, RepoAction>;
  expanded: Record<string, boolean>;
  contextBarPosition: ContextBarPosition;
  paneSizes: Record<string, number | string>;
  collapsedPaths: Record<string, string[]>;
  fileSearchRepoId: string | null;

  // Global layout state (applies across all workspaces)
  layoutMode: LayoutMode;
  isLeftSidebarVisible: boolean;
  isRightSidebarVisible: boolean;
  isTerminalVisible: boolean;
  previewRefreshKey: number;
  isProjectTerminalOpen: boolean;
  // Note: Kanban issue panel state (selectedKanbanIssueId, createMode, etc.)
  // is derived from URL via app navigation route state

  // Workspace-specific panel state
  workspacePanelStates: Record<string, WorkspacePanelState>;

  // Selected built-in kanban view per project
  kanbanProjectViewSelections: Record<string, KanbanProjectViewSelection>;

  // In-memory kanban runtime preferences per project and view
  kanbanProjectViewPreferences: Record<
    string,
    Record<string, KanbanProjectViewPreferences>
  >;

  // Kanban view mode state
  kanbanViewMode: KanbanViewMode;
  listViewStatusFilter: string | null;

  // Mobile tab state
  mobileActiveTab: MobileTab;

  // Mobile font scale
  mobileFontScale: MobileFontScale;

  // Per-workspace custom colors (sidebar tree tint). `null` value clears.
  workspaceColors: Record<string, string>;

  // Persisted default pipeline id for the Create Issue dialog (single-select).
  defaultPipelineId: string | null;

  // Animated border around the working message box (toggleable in settings)
  animateRunningOutline: boolean;

  // Global thinking visibility (header button expands/collapses all blocks)
  thinkingExpanded: boolean;

  // Auto-compaction threshold ('50' | '65' | '75' | '85' | '95' | 'full')
  compactionThreshold: CompactionThreshold;
  setCompactionThreshold: (threshold: CompactionThreshold) => void;

  // Compactor Engine & Classifier selection ('auto' | 'laya' | 'jev' | 'disabled')
  compactorEngine: CompactorEngineType;
  setCompactorEngine: (engine: CompactorEngineType) => void;

  // Laya Mode ('docker' | 'cloud') & URLs
  layaMode: LayaExecutionMode;
  setLayaMode: (mode: LayaExecutionMode) => void;
  layaDockerUrl: string;
  setLayaDockerUrl: (url: string) => void;
  layaCloudUrl: string;
  setLayaCloudUrl: (url: string) => void;

  // TypeSafe Jev API Key
  jevApiKey: string;
  setJevApiKey: (key: string) => void;

  // Official TypeSafe (Jev) API endpoint
  jevTypesafeUrl: string;
  setJevTypesafeUrl: (url: string) => void;

  // Laya System-1 Guardrails
  layaGuardrailsEnabled: boolean;
  setLayaGuardrailsEnabled: (enabled: boolean) => void;

  // Abide Active Rule Guardrails
  abideGuardrailsEnabled: boolean;
  setAbideGuardrailsEnabled: (enabled: boolean) => void;
  abideGuardrailsEngine: AbideGuardrailsEngine;
  setAbideGuardrailsEngine: (engine: AbideGuardrailsEngine) => void;
  abideGuardrailsAction: AbideGuardrailsAction;
  setAbideGuardrailsAction: (action: AbideGuardrailsAction) => void;

  // Specific Rule Activation Checkboxes
  guardrailProtectedFiles: boolean;
  setGuardrailProtectedFiles: (enabled: boolean) => void;
  guardrailAiAttribution: boolean;
  setGuardrailAiAttribution: (enabled: boolean) => void;
  guardrailSecretLeak: boolean;
  setGuardrailSecretLeak: (enabled: boolean) => void;
  guardrailGitOps: boolean;
  setGuardrailGitOps: (enabled: boolean) => void;
  guardrailSemanticJev: boolean;
  setGuardrailSemanticJev: (enabled: boolean) => void;

  // Last selected project (persisted via scratch store).
  // ADR-018 — `selectedOrgId` removed.
  selectedProjectId: string | null;
  // Last visited workspace (client-side localStorage, restored on app launch).
  lastWorkspaceId: string | null;
  createDraftWorkspaceByDefault: boolean;

  // Global left sidebar width (px) — persisted to localStorage, global for any workspace and across app reloads.
  leftSidebarWidth: number;

  // Auto-move kanban cards between columns on workspace create / pipeline / merge.
  autoMoveCardsEnabled: boolean;

  // Workspaces dashboard project filter (2026-08-07): when set, the
  // /workspaces dashboard narrows to this project's workspaces. In-memory
  // only (not persisted) — set by the sidebar Workspaces section icon and
  // cleared via the dashboard's "All workspaces" toggle.
  workspacesDashboardProjectId: string | null;
  setWorkspacesDashboardProjectId: (projectId: string | null) => void;

  // UI preferences actions
  setRepoAction: (repoId: string, action: RepoAction) => void;
  setExpanded: (key: string, value: boolean) => void;
  toggleExpanded: (key: string, defaultValue?: boolean) => void;
  setExpandedAll: (keys: string[], value: boolean) => void;
  setContextBarPosition: (position: ContextBarPosition) => void;
  setPaneSize: (key: string, size: number | string) => void;
  setCollapsedPaths: (key: string, paths: string[]) => void;
  setFileSearchRepo: (repoId: string | null) => void;

  // Layout actions
  setLayoutMode: (mode: LayoutMode) => void;
  toggleLayoutMode: () => void;
  toggleLeftSidebar: () => void;
  toggleLeftMainPanel: (workspaceId?: string) => void;
  toggleRightSidebar: () => void;
  toggleTerminal: () => void;
  setTerminalVisible: (value: boolean) => void;
  toggleProjectTerminal: () => void;
  setProjectTerminalOpen: (value: boolean) => void;
  // Note: Kanban panel actions (openKanbanIssuePanel, closeKanbanIssuePanel, etc.)
  // are handled by app navigation
  toggleRightMainPanelMode: (
    mode: RightMainPanelMode,
    workspaceId?: string
  ) => void;
  setRightMainPanelMode: (
    mode: RightMainPanelMode | null,
    workspaceId?: string
  ) => void;
  setLeftSidebarVisible: (value: boolean) => void;
  setLeftMainPanelVisible: (value: boolean, workspaceId?: string) => void;
  triggerPreviewRefresh: () => void;

  // Workspace-specific panel state actions
  getWorkspacePanelState: (workspaceId: string) => WorkspacePanelState;
  setWorkspacePanelState: (
    workspaceId: string,
    state: Partial<WorkspacePanelState>
  ) => void;

  // Kanban view selection actions
  setKanbanProjectView: (projectId: string, viewId: string) => void;
  setKanbanProjectViewFilters: (
    projectId: string,
    viewId: string,
    filters: KanbanFilterState
  ) => void;
  setKanbanProjectViewShowSubIssues: (
    projectId: string,
    viewId: string,
    show: boolean
  ) => void;
  setKanbanProjectViewShowWorkspaces: (
    projectId: string,
    viewId: string,
    show: boolean
  ) => void;
  setKanbanProjectViewHideBlocked: (
    projectId: string,
    viewId: string,
    hide: boolean
  ) => void;
  clearKanbanProjectViewPreferences: (
    projectId: string,
    viewId: string
  ) => void;

  // Kanban view mode actions
  setKanbanViewMode: (mode: KanbanViewMode) => void;
  setListViewStatusFilter: (statusId: string | null) => void;

  // Mobile tab actions
  setMobileActiveTab: (tab: MobileTab) => void;

  // Mobile font scale actions
  setMobileFontScale: (scale: MobileFontScale) => void;

  // Workspace color actions
  setWorkspaceColor: (workspaceId: string, color: string | null) => void;

  // Default pipeline actions
  setDefaultPipelineId: (id: string | null) => void;

  // Animated running outline actions
  setAnimateRunningOutline: (value: boolean) => void;

  // Global thinking visibility action
  setThinkingExpanded: (value: boolean) => void;

  // Typography and custom appearance
  uiFontFamily: UiFontFamily;
  codeFontFamily: CodeFontFamily;
  uiFontScale: UiFontScale;
  codeFontSize: CodeFontSize;
  customThemeEnabled: boolean;
  customTheme: CustomThemeConfig;
  savedCustomThemes: CustomThemeConfig[];

  setUiFontFamily: (font: UiFontFamily) => void;
  setCodeFontFamily: (font: CodeFontFamily) => void;
  setUiFontScale: (scale: UiFontScale) => void;
  setCodeFontSize: (size: CodeFontSize) => void;
  setCustomThemeEnabled: (enabled: boolean) => void;
  setCustomTheme: (theme: Partial<CustomThemeConfig>) => void;
  saveCurrentCustomTheme: (name: string) => void;
  applySavedCustomTheme: (theme: CustomThemeConfig) => void;
  deleteSavedCustomTheme: (name: string) => void;
  resetAppearanceDefaults: () => void;

  // Last selected project actions
  setSelectedProjectId: (projectId: string | null) => void;
  // Last workspace actions (client-side only)
  setLastWorkspaceId: (workspaceId: string | null) => void;
  setCreateDraftWorkspaceByDefault: (value: boolean) => void;
  setAutoMoveCardsEnabled: (value: boolean) => void;
  setLeftSidebarWidth: (width: number) => void;
};

export const useUiPreferencesStore = create<State>()((set, get) => ({
  // UI preferences state
  repoActions: {},
  expanded: {},
  contextBarPosition: 'middle-right',
  paneSizes: loadLocalPaneSizes(),
  collapsedPaths: {},
  fileSearchRepoId: null,

  // Global layout state
  layoutMode: 'workspaces' as LayoutMode,
  isLeftSidebarVisible: true,
  isRightSidebarVisible: true,
  isTerminalVisible: true,
  previewRefreshKey: 0,
  isProjectTerminalOpen: false,

  // Workspace-specific panel state
  workspacePanelStates: {},

  // Kanban per-project view selection
  kanbanProjectViewSelections: {},
  kanbanProjectViewPreferences: {},

  // Kanban view mode state
  kanbanViewMode: 'kanban' as KanbanViewMode,
  listViewStatusFilter: null,

  // Mobile tab state
  mobileActiveTab: 'chat' as MobileTab,

  // Mobile font scale
  mobileFontScale: loadMobileFontScale(),

  // Typography and custom appearance
  uiFontFamily: loadUiFontFamily(),
  codeFontFamily: loadCodeFontFamily(),
  uiFontScale: loadUiFontScale(),
  codeFontSize: loadCodeFontSize(),
  customThemeEnabled: loadCustomThemeEnabled(),
  customTheme: loadCustomTheme(),
  savedCustomThemes: loadSavedCustomThemes(),

  // Per-workspace custom colors
  workspaceColors: loadWorkspaceColors(),

  // Persisted default pipeline id (single-select Create Issue dialog)
  defaultPipelineId: loadDefaultPipelineId(),

  // Animated running outline (default on)
  animateRunningOutline: loadAnimateRunningOutline(),

  // Global thinking visibility (default expanded)
  thinkingExpanded: loadThinkingExpanded(),

  // Auto-compaction threshold
  compactionThreshold: loadCompactionThreshold(),
  setCompactionThreshold: (threshold) => {
    try {
      localStorage.setItem(COMPACTION_THRESHOLD_KEY, threshold);
    } catch {
      // localStorage unavailable
    }
    set({ compactionThreshold: threshold });
  },

  // Compactor Engine & Classifier
  compactorEngine: loadCompactorEngine(),
  setCompactorEngine: (engine) => {
    try {
      localStorage.setItem(COMPACTOR_ENGINE_KEY, engine);
    } catch {}
    set({ compactorEngine: engine });
  },

  // Laya Mode & URLs
  layaMode: loadLayaMode(),
  setLayaMode: (mode) => {
    try {
      localStorage.setItem(LAYA_MODE_KEY, mode);
    } catch {}
    set({ layaMode: mode });
  },
  layaDockerUrl: loadLayaDockerUrl(),
  setLayaDockerUrl: (url) => {
    try {
      localStorage.setItem(LAYA_DOCKER_URL_KEY, url);
    } catch {}
    set({ layaDockerUrl: url });
  },
  layaCloudUrl: loadLayaCloudUrl(),
  setLayaCloudUrl: (url) => {
    try {
      localStorage.setItem(LAYA_CLOUD_URL_KEY, url);
    } catch {}
    set({ layaCloudUrl: url });
  },

  // TypeSafe Jev API Key
  jevApiKey: loadJevApiKey(),
  setJevApiKey: (key) => {
    try {
      localStorage.setItem(JEV_API_KEY_STORAGE_KEY, key);
    } catch {}
    set({ jevApiKey: key });
  },

  // Official TypeSafe (Jev) API endpoint
  jevTypesafeUrl: loadJevTypesafeUrl(),
  setJevTypesafeUrl: (url) => {
    try {
      localStorage.setItem(JEV_TYPESAFE_URL_KEY, url);
    } catch {}
    set({ jevTypesafeUrl: url });
  },

  // Laya Guardrails
  layaGuardrailsEnabled: loadLayaGuardrailsEnabled(),
  setLayaGuardrailsEnabled: (enabled) => {
    try {
      localStorage.setItem(LAYA_GUARDRAILS_ENABLED_KEY, String(enabled));
    } catch {}
    set({ layaGuardrailsEnabled: enabled });
  },

  // Abide Active Rule Guardrails
  abideGuardrailsEnabled: loadAbideGuardrailsEnabled(),
  setAbideGuardrailsEnabled: (enabled) => {
    try {
      localStorage.setItem(ABIDE_GUARDRAILS_ENABLED_KEY, String(enabled));
    } catch {}
    set({ abideGuardrailsEnabled: enabled });
  },
  abideGuardrailsEngine: loadAbideGuardrailsEngine(),
  setAbideGuardrailsEngine: (engine) => {
    try {
      localStorage.setItem(ABIDE_GUARDRAILS_ENGINE_KEY, engine);
    } catch {}
    set({ abideGuardrailsEngine: engine });
  },
  abideGuardrailsAction: loadAbideGuardrailsAction(),
  setAbideGuardrailsAction: (action) => {
    try {
      localStorage.setItem(ABIDE_GUARDRAILS_ACTION_KEY, action);
    } catch {}
    set({ abideGuardrailsAction: action });
  },

  // Specific Rule Activation Checkboxes
  guardrailProtectedFiles: loadBoolPref(GUARDRAIL_PROTECTED_FILES_KEY),
  setGuardrailProtectedFiles: (enabled) => {
    try {
      localStorage.setItem(GUARDRAIL_PROTECTED_FILES_KEY, String(enabled));
    } catch {}
    set({ guardrailProtectedFiles: enabled });
  },
  guardrailAiAttribution: loadBoolPref(GUARDRAIL_AI_ATTRIBUTION_KEY),
  setGuardrailAiAttribution: (enabled) => {
    try {
      localStorage.setItem(GUARDRAIL_AI_ATTRIBUTION_KEY, String(enabled));
    } catch {}
    set({ guardrailAiAttribution: enabled });
  },
  guardrailSecretLeak: loadBoolPref(GUARDRAIL_SECRET_LEAK_KEY),
  setGuardrailSecretLeak: (enabled) => {
    try {
      localStorage.setItem(GUARDRAIL_SECRET_LEAK_KEY, String(enabled));
    } catch {}
    set({ guardrailSecretLeak: enabled });
  },
  guardrailGitOps: loadBoolPref(GUARDRAIL_GIT_OPS_KEY),
  setGuardrailGitOps: (enabled) => {
    try {
      localStorage.setItem(GUARDRAIL_GIT_OPS_KEY, String(enabled));
    } catch {}
    set({ guardrailGitOps: enabled });
  },
  guardrailSemanticJev: loadBoolPref(GUARDRAIL_SEMANTIC_JEV_KEY),
  setGuardrailSemanticJev: (enabled) => {
    try {
      localStorage.setItem(GUARDRAIL_SEMANTIC_JEV_KEY, String(enabled));
    } catch {}
    set({ guardrailSemanticJev: enabled });
  },

  // Typography & Custom Theme actions
  setUiFontFamily: (font) => {
    try {
      localStorage.setItem(UI_FONT_FAMILY_KEY, font);
    } catch {}
    set({ uiFontFamily: font });
  },
  setCodeFontFamily: (font) => {
    try {
      localStorage.setItem(CODE_FONT_FAMILY_KEY, font);
    } catch {}
    set({ codeFontFamily: font });
  },
  setUiFontScale: (scale) => {
    try {
      localStorage.setItem(UI_FONT_SCALE_KEY, scale);
    } catch {}
    set({ uiFontScale: scale });
  },
  setCodeFontSize: (size) => {
    try {
      localStorage.setItem(CODE_FONT_SIZE_KEY, String(size));
    } catch {}
    set({ codeFontSize: size });
  },
  setCustomThemeEnabled: (enabled) => {
    try {
      localStorage.setItem(CUSTOM_THEME_ENABLED_KEY, String(enabled));
    } catch {}
    set({ customThemeEnabled: enabled });
  },
  setCustomTheme: (themeUpdate) => {
    const next = { ...get().customTheme, ...themeUpdate };
    try {
      localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(next));
    } catch {}
    set({ customTheme: next });
  },
  saveCurrentCustomTheme: (name) => {
    const themeToSave: CustomThemeConfig = { ...get().customTheme, name };
    const filtered = get().savedCustomThemes.filter((t) => t.name !== name);
    const updated = [...filtered, themeToSave];
    try {
      localStorage.setItem(SAVED_CUSTOM_THEMES_KEY, JSON.stringify(updated));
      localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(themeToSave));
    } catch {}
    set({ customTheme: themeToSave, savedCustomThemes: updated });
  },
  applySavedCustomTheme: (theme) => {
    try {
      localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(theme));
      localStorage.setItem(CUSTOM_THEME_ENABLED_KEY, 'true');
    } catch {}
    set({ customTheme: theme, customThemeEnabled: true });
  },
  deleteSavedCustomTheme: (name) => {
    const updated = get().savedCustomThemes.filter((t) => t.name !== name);
    try {
      localStorage.setItem(SAVED_CUSTOM_THEMES_KEY, JSON.stringify(updated));
    } catch {}
    set({ savedCustomThemes: updated });
  },
  resetAppearanceDefaults: () => {
    try {
      localStorage.removeItem(UI_FONT_FAMILY_KEY);
      localStorage.removeItem(CODE_FONT_FAMILY_KEY);
      localStorage.removeItem(UI_FONT_SCALE_KEY);
      localStorage.removeItem(CODE_FONT_SIZE_KEY);
      localStorage.removeItem(CUSTOM_THEME_ENABLED_KEY);
      localStorage.removeItem(CUSTOM_THEME_KEY);
    } catch {}
    set({
      uiFontFamily: DEFAULT_UI_FONT_FAMILY,
      codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
      uiFontScale: DEFAULT_UI_FONT_SCALE,
      codeFontSize: DEFAULT_CODE_FONT_SIZE,
      customThemeEnabled: true,
      customTheme: DEFAULT_CUSTOM_THEME,
    });
  },

  // Last selected project (ADR-018 — `selectedOrgId` removed)
  selectedProjectId: null,
  // Last workspace (client-side)
  lastWorkspaceId: loadLastWorkspaceId(),
  createDraftWorkspaceByDefault: DEFAULT_CREATE_DRAFT_WORKSPACE_BY_DEFAULT,
  autoMoveCardsEnabled: true,

  // Global left sidebar width (px) — global for any workspace, persists across reloads.
  leftSidebarWidth: loadLeftSidebarWidth(),

  // Workspaces dashboard project filter (in-memory only).
  workspacesDashboardProjectId: null,

  // UI preferences actions
  setRepoAction: (repoId, action) =>
    set((s) => ({ repoActions: { ...s.repoActions, [repoId]: action } })),
  setExpanded: (key, value) =>
    set((s) => ({ expanded: { ...s.expanded, [key]: value } })),
  toggleExpanded: (key, defaultValue = true) =>
    set((s) => ({
      expanded: {
        ...s.expanded,
        [key]: !(s.expanded[key] ?? defaultValue),
      },
    })),
  setExpandedAll: (keys, value) =>
    set((s) => ({
      expanded: {
        ...s.expanded,
        ...Object.fromEntries(keys.map((k) => [k, value])),
      },
    })),
  setContextBarPosition: (position) => set({ contextBarPosition: position }),
  setPaneSize: (key, size) => {
    saveLocalPaneSize(key, size);
    set((s) => ({ paneSizes: { ...s.paneSizes, [key]: size } }));
  },
  setCollapsedPaths: (key, paths) =>
    set((s) => ({ collapsedPaths: { ...s.collapsedPaths, [key]: paths } })),
  setFileSearchRepo: (repoId) => set({ fileSearchRepoId: repoId }),

  // Layout actions
  setLayoutMode: (mode) => set({ layoutMode: mode }),
  toggleLayoutMode: () =>
    set((s) => ({
      layoutMode: s.layoutMode === 'workspaces' ? 'kanban' : 'workspaces',
    })),
  toggleLeftSidebar: () =>
    set((s) => ({ isLeftSidebarVisible: !s.isLeftSidebarVisible })),

  toggleLeftMainPanel: (workspaceId) => {
    if (!workspaceId) return;
    const state = get();
    const wsState =
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE;
    if (wsState.isLeftMainPanelVisible && wsState.rightMainPanelMode === null)
      return;
    set({
      workspacePanelStates: {
        ...state.workspacePanelStates,
        [workspaceId]: {
          ...wsState,
          isLeftMainPanelVisible: !wsState.isLeftMainPanelVisible,
        },
      },
    });
  },

  toggleRightSidebar: () =>
    set((s) => ({ isRightSidebarVisible: !s.isRightSidebarVisible })),

  toggleTerminal: () =>
    set((s) => ({ isTerminalVisible: !s.isTerminalVisible })),

  setTerminalVisible: (value) => set({ isTerminalVisible: value }),

  toggleProjectTerminal: () =>
    set((s) => ({ isProjectTerminalOpen: !s.isProjectTerminalOpen })),

  setProjectTerminalOpen: (value) => set({ isProjectTerminalOpen: value }),

  toggleRightMainPanelMode: (mode, workspaceId) => {
    if (!workspaceId) return;
    const state = get();
    const wsState =
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE;
    const isCurrentlyActive = wsState.rightMainPanelMode === mode;
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    set({
      workspacePanelStates: {
        ...state.workspacePanelStates,
        [workspaceId]: {
          ...wsState,
          rightMainPanelMode: isCurrentlyActive ? null : mode,
        },
      },
      isLeftSidebarVisible: isCurrentlyActive
        ? true
        : isWideScreen()
          ? state.isLeftSidebarVisible
          : false,
      ...(isMobile &&
        !isCurrentlyActive && { mobileActiveTab: mode as MobileTab }),
    });
  },

  setRightMainPanelMode: (mode, workspaceId) => {
    if (!workspaceId) return;
    const state = get();
    const wsState =
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE;
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    set({
      workspacePanelStates: {
        ...state.workspacePanelStates,
        [workspaceId]: {
          ...wsState,
          rightMainPanelMode: mode,
        },
      },
      ...(mode !== null && {
        isLeftSidebarVisible: isWideScreen()
          ? state.isLeftSidebarVisible
          : false,
      }),
      ...(isMobile && mode !== null && { mobileActiveTab: mode as MobileTab }),
    });
  },

  setLeftSidebarVisible: (value) => set({ isLeftSidebarVisible: value }),

  setLeftMainPanelVisible: (value, workspaceId) => {
    if (!workspaceId) return;
    const state = get();
    const wsState =
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE;
    set({
      workspacePanelStates: {
        ...state.workspacePanelStates,
        [workspaceId]: {
          ...wsState,
          isLeftMainPanelVisible: value,
        },
      },
    });
  },

  triggerPreviewRefresh: () =>
    set((s) => ({ previewRefreshKey: s.previewRefreshKey + 1 })),

  // Workspace-specific panel state actions
  getWorkspacePanelState: (workspaceId) => {
    const state = get();
    return (
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE
    );
  },

  setWorkspacePanelState: (workspaceId, panelState) => {
    const state = get();
    const currentWsState =
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE;
    set({
      workspacePanelStates: {
        ...state.workspacePanelStates,
        [workspaceId]: {
          ...currentWsState,
          ...panelState,
        },
      },
    });
  },

  // Kanban view selection actions
  setKanbanProjectView: (projectId, viewId) => {
    if (!isKanbanProjectViewId(viewId)) {
      return;
    }

    set((s) => ({
      kanbanProjectViewSelections: {
        ...s.kanbanProjectViewSelections,
        [projectId]: { activeViewId: viewId },
      },
    }));
  },

  setKanbanProjectViewFilters: (projectId, viewId, filters) => {
    if (!isKanbanProjectViewId(viewId)) {
      return;
    }

    set((s) => {
      const projectPreferences =
        s.kanbanProjectViewPreferences[projectId] ?? {};
      const existingPreferences =
        projectPreferences[viewId] ??
        createDefaultKanbanProjectViewPreferences(viewId);

      return {
        kanbanProjectViewPreferences: {
          ...s.kanbanProjectViewPreferences,
          [projectId]: {
            ...projectPreferences,
            [viewId]: {
              ...existingPreferences,
              filters: cloneKanbanFilters(filters),
            },
          },
        },
      };
    });
  },

  setKanbanProjectViewShowSubIssues: (projectId, viewId, show) => {
    if (!isKanbanProjectViewId(viewId)) {
      return;
    }

    set((s) => {
      const projectPreferences =
        s.kanbanProjectViewPreferences[projectId] ?? {};
      const existingPreferences =
        projectPreferences[viewId] ??
        createDefaultKanbanProjectViewPreferences(viewId);

      return {
        kanbanProjectViewPreferences: {
          ...s.kanbanProjectViewPreferences,
          [projectId]: {
            ...projectPreferences,
            [viewId]: {
              ...existingPreferences,
              showSubIssues: show,
            },
          },
        },
      };
    });
  },

  setKanbanProjectViewShowWorkspaces: (projectId, viewId, show) => {
    if (!isKanbanProjectViewId(viewId)) {
      return;
    }

    set((s) => {
      const projectPreferences =
        s.kanbanProjectViewPreferences[projectId] ?? {};
      const existingPreferences =
        projectPreferences[viewId] ??
        createDefaultKanbanProjectViewPreferences(viewId);

      return {
        kanbanProjectViewPreferences: {
          ...s.kanbanProjectViewPreferences,
          [projectId]: {
            ...projectPreferences,
            [viewId]: {
              ...existingPreferences,
              showWorkspaces: show,
            },
          },
        },
      };
    });
  },

  setKanbanProjectViewHideBlocked: (projectId, viewId, hide) => {
    if (!isKanbanProjectViewId(viewId)) {
      return;
    }

    set((s) => {
      const projectPreferences =
        s.kanbanProjectViewPreferences[projectId] ?? {};
      const existingPreferences =
        projectPreferences[viewId] ??
        createDefaultKanbanProjectViewPreferences(viewId);

      return {
        kanbanProjectViewPreferences: {
          ...s.kanbanProjectViewPreferences,
          [projectId]: {
            ...projectPreferences,
            [viewId]: {
              ...existingPreferences,
              hideBlocked: hide,
            },
          },
        },
      };
    });
  },

  clearKanbanProjectViewPreferences: (projectId, viewId) => {
    if (!isKanbanProjectViewId(viewId)) {
      return;
    }

    set((s) => {
      const projectPreferences = s.kanbanProjectViewPreferences[projectId];
      if (!projectPreferences || !projectPreferences[viewId]) {
        return {};
      }

      const nextProjectPreferences = { ...projectPreferences };
      delete nextProjectPreferences[viewId];

      const nextAllPreferences = { ...s.kanbanProjectViewPreferences };
      if (Object.keys(nextProjectPreferences).length === 0) {
        delete nextAllPreferences[projectId];
      } else {
        nextAllPreferences[projectId] = nextProjectPreferences;
      }

      return {
        kanbanProjectViewPreferences: nextAllPreferences,
      };
    });
  },

  // Kanban view mode actions
  setKanbanViewMode: (mode) => set({ kanbanViewMode: mode }),

  setListViewStatusFilter: (statusId) =>
    set({ listViewStatusFilter: statusId }),

  // Mobile tab actions
  setMobileActiveTab: (tab) => set({ mobileActiveTab: tab }),

  // Mobile font scale actions
  setMobileFontScale: (scale) => {
    try {
      if (scale === 'default') {
        localStorage.removeItem(MOBILE_FONT_SCALE_KEY);
      } else {
        localStorage.setItem(MOBILE_FONT_SCALE_KEY, scale);
      }
    } catch {
      // localStorage may be unavailable
    }
    set({ mobileFontScale: scale });
  },

  // Workspace color actions
  setWorkspaceColor: (workspaceId, color) => {
    set((s) => {
      const next = { ...s.workspaceColors };
      if (color === null) {
        delete next[workspaceId];
      } else {
        next[workspaceId] = color;
      }
      // Hard cap so a long-lived install can't grow the map unboundedly.
      const ids = Object.keys(next);
      if (ids.length > WORKSPACE_COLORS_LIMIT) {
        for (const id of ids.slice(0, ids.length - WORKSPACE_COLORS_LIMIT)) {
          delete next[id];
        }
      }
      saveWorkspaceColors(next);
      return { workspaceColors: next };
    });
  },

  // Default pipeline actions
  setDefaultPipelineId: (id) => {
    try {
      if (id) {
        localStorage.setItem(DEFAULT_PIPELINE_KEY, id);
      } else {
        localStorage.removeItem(DEFAULT_PIPELINE_KEY);
      }
    } catch {
      // localStorage may be unavailable
    }
    set({ defaultPipelineId: id });
  },

  // Animated running outline actions
  setAnimateRunningOutline: (value) => {
    try {
      if (value) {
        localStorage.removeItem(ANIMATE_RUNNING_OUTLINE_KEY);
      } else {
        localStorage.setItem(ANIMATE_RUNNING_OUTLINE_KEY, 'false');
      }
    } catch {
      // localStorage may be unavailable
    }
    set({ animateRunningOutline: value });
  },

  // Global thinking visibility: flips the preference and applies it to every
  // persisted thinking block so a single click expands/collapses them all.
  setThinkingExpanded: (value) => {
    try {
      if (value) {
        localStorage.removeItem(THINKING_EXPANDED_KEY);
      } else {
        localStorage.setItem(THINKING_EXPANDED_KEY, 'false');
      }
    } catch {
      // localStorage may be unavailable
    }
    set((s) => {
      const nextExpanded = { ...s.expanded };
      for (const key of Object.keys(nextExpanded)) {
        if (key.startsWith('thinking:')) {
          nextExpanded[key] = value;
        }
      }
      return { thinkingExpanded: value, expanded: nextExpanded };
    });
  },

  // Last selected project actions
  setSelectedProjectId: (projectId) => set({ selectedProjectId: projectId }),
  setLastWorkspaceId: (workspaceId) => {
    try {
      if (workspaceId) {
        localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);
      } else {
        localStorage.removeItem(LAST_WORKSPACE_KEY);
      }
    } catch {
      // localStorage may be unavailable
    }
    set({ lastWorkspaceId: workspaceId });
  },
  setWorkspacesDashboardProjectId: (projectId) =>
    set({ workspacesDashboardProjectId: projectId }),
  setCreateDraftWorkspaceByDefault: (value) =>
    set({ createDraftWorkspaceByDefault: value }),
  setAutoMoveCardsEnabled: (value) => set({ autoMoveCardsEnabled: value }),
  setLeftSidebarWidth: (width) => {
    const clamped = clampLeftSidebarWidth(width);
    saveLeftSidebarWidth(clamped);
    set({ leftSidebarWidth: clamped });
  },
}));

// Hook for repo action preference
export function useRepoAction(
  repoId: string,
  defaultAction: RepoAction = 'pull-request'
): [RepoAction, (action: RepoAction) => void] {
  const action = useUiPreferencesStore(
    (s) => s.repoActions[repoId] ?? defaultAction
  );
  const setAction = useUiPreferencesStore((s) => s.setRepoAction);
  return [action, (a) => setAction(repoId, a)];
}

// Hook for persisted expanded state
export function usePersistedExpanded(
  key: PersistKey,
  defaultValue = true
): [boolean, (value?: boolean) => void] {
  const expanded = useUiPreferencesStore(
    (s) => s.expanded[key] ?? defaultValue
  );
  const setExpanded = useUiPreferencesStore((s) => s.setExpanded);
  const toggleExpanded = useUiPreferencesStore((s) => s.toggleExpanded);

  const set = (value?: boolean) => {
    if (typeof value === 'boolean') setExpanded(key, value);
    else toggleExpanded(key, defaultValue);
  };

  return [expanded, set];
}

// Hook for context bar position
export function useContextBarPosition(): [
  ContextBarPosition,
  (position: ContextBarPosition) => void,
] {
  const position = useUiPreferencesStore((s) => s.contextBarPosition);
  const setPosition = useUiPreferencesStore((s) => s.setContextBarPosition);
  return [position, setPosition];
}

// Hook for pane size preference
export function usePaneSize(
  key: PersistKey,
  defaultSize: number | string
): [number | string, (size: number | string) => void] {
  const size = useUiPreferencesStore((s) => s.paneSizes[key] ?? defaultSize);
  const setSize = useUiPreferencesStore((s) => s.setPaneSize);
  return [size, (s) => setSize(key, s)];
}

// Hook for bulk expanded state operations
export function useExpandedAll() {
  const expanded = useUiPreferencesStore((s) => s.expanded);
  const setExpanded = useUiPreferencesStore((s) => s.setExpanded);
  const setExpandedAll = useUiPreferencesStore((s) => s.setExpandedAll);
  return { expanded, setExpanded, setExpandedAll };
}

// Hook for persisted file tree collapsed paths (per workspace)
export function usePersistedCollapsedPaths(
  workspaceId: string | undefined
): [
  Set<string>,
  (paths: Set<string> | ((prev: Set<string>) => Set<string>)) => void,
] {
  const key = workspaceId ? `file-tree:${workspaceId}` : '';
  const paths = useUiPreferencesStore((s) => s.collapsedPaths[key] ?? []);
  const setPaths = useUiPreferencesStore((s) => s.setCollapsedPaths);

  const pathSet = useMemo(() => new Set(paths), [paths]);
  const pathSetRef = useRef(pathSet);
  pathSetRef.current = pathSet;

  const setPathSet = useCallback(
    (newPaths: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      if (!key) return;
      const resolved =
        typeof newPaths === 'function'
          ? newPaths(pathSetRef.current)
          : newPaths;
      setPaths(key, [...resolved]);
    },
    [key, setPaths]
  );

  return [pathSet, setPathSet];
}

// Hook for mobile active tab
export function useMobileActiveTab() {
  const tab = useUiPreferencesStore((s) => s.mobileActiveTab);
  const set = useUiPreferencesStore((s) => s.setMobileActiveTab);
  return [tab, set] as const;
}

// Hook for mobile font scale
export function useMobileFontScale() {
  const scale = useUiPreferencesStore((s) => s.mobileFontScale);
  const set = useUiPreferencesStore((s) => s.setMobileFontScale);
  return [scale, set] as const;
}

// Hook for the persisted default pipeline id (single-select Create Issue dialog)
export function useDefaultPipelineId() {
  const id = useUiPreferencesStore((s) => s.defaultPipelineId);
  const set = useUiPreferencesStore((s) => s.setDefaultPipelineId);
  return [id, set] as const;
}

// Hook for the combined pipeline selection (pipeline id + ticked stage ids),
// persisted to localStorage so the operator's last pipeline/stage choice is
// re-applied on the next card.
export function useDefaultPipelineSelectionPref(): [
  PipelineSelectionPref,
  (pref: PipelineSelectionPref) => void,
] {
  const [pref, setPref] = useState<PipelineSelectionPref>(() =>
    loadPipelineSelectionPref()
  );
  const set = useCallback((next: PipelineSelectionPref) => {
    setPref(next);
    savePipelineSelectionPref(next);
  }, []);
  return [pref, set];
}

// Hook for the animated running outline toggle
export function useAnimateRunningOutline() {
  const value = useUiPreferencesStore((s) => s.animateRunningOutline);
  const set = useUiPreferencesStore((s) => s.setAnimateRunningOutline);
  return [value, set] as const;
}

// Hook for the global thinking visibility toggle
export function useThinkingExpanded() {
  const value = useUiPreferencesStore((s) => s.thinkingExpanded);
  const set = useUiPreferencesStore((s) => s.setThinkingExpanded);
  return [value, set] as const;
}

// Hook for workspace-specific panel state
export function useWorkspacePanelState(workspaceId: string | undefined) {
  // Subscribe only to this workspace's panel state slice (not the entire map)
  const wsState = useUiPreferencesStore((s) =>
    workspaceId
      ? (s.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE)
      : DEFAULT_WORKSPACE_PANEL_STATE
  );

  // Global state (sidebars are global)
  const isLeftSidebarVisible = useUiPreferencesStore(
    (s) => s.isLeftSidebarVisible
  );
  const isRightSidebarVisible = useUiPreferencesStore(
    (s) => s.isRightSidebarVisible
  );
  const isTerminalVisible = useUiPreferencesStore((s) => s.isTerminalVisible);

  // Actions from store
  const toggleRightMainPanelMode = useUiPreferencesStore(
    (s) => s.toggleRightMainPanelMode
  );
  const setRightMainPanelMode = useUiPreferencesStore(
    (s) => s.setRightMainPanelMode
  );
  const setLeftMainPanelVisible = useUiPreferencesStore(
    (s) => s.setLeftMainPanelVisible
  );
  const setLeftSidebarVisible = useUiPreferencesStore(
    (s) => s.setLeftSidebarVisible
  );

  // Memoized callbacks that include workspaceId
  const toggleRightMainPanelModeForWorkspace = useCallback(
    (mode: RightMainPanelMode) => toggleRightMainPanelMode(mode, workspaceId),
    [toggleRightMainPanelMode, workspaceId]
  );

  const setRightMainPanelModeForWorkspace = useCallback(
    (mode: RightMainPanelMode | null) =>
      setRightMainPanelMode(mode, workspaceId),
    [setRightMainPanelMode, workspaceId]
  );

  const setLeftMainPanelVisibleForWorkspace = useCallback(
    (value: boolean) => setLeftMainPanelVisible(value, workspaceId),
    [setLeftMainPanelVisible, workspaceId]
  );

  return {
    // Workspace-specific state
    rightMainPanelMode: wsState.rightMainPanelMode,
    isLeftMainPanelVisible: wsState.isLeftMainPanelVisible,

    // Global state (sidebars and terminal)
    isLeftSidebarVisible,
    isRightSidebarVisible,
    isTerminalVisible,

    // Workspace-specific actions
    toggleRightMainPanelMode: toggleRightMainPanelModeForWorkspace,
    setRightMainPanelMode: setRightMainPanelModeForWorkspace,
    setLeftMainPanelVisible: setLeftMainPanelVisibleForWorkspace,

    // Global actions
    setLeftSidebarVisible,
  };
}

export const useCompactionThreshold = () =>
  useUiPreferencesStore((s) => s.compactionThreshold);
export const useSetCompactionThreshold = () =>
  useUiPreferencesStore((s) => s.setCompactionThreshold);

export const useCompactorEngine = () =>
  useUiPreferencesStore((s) => s.compactorEngine);
export const useSetCompactorEngine = () =>
  useUiPreferencesStore((s) => s.setCompactorEngine);

export const useLayaMode = () => useUiPreferencesStore((s) => s.layaMode);
export const useSetLayaMode = () => useUiPreferencesStore((s) => s.setLayaMode);

export const useLayaDockerUrl = () =>
  useUiPreferencesStore((s) => s.layaDockerUrl);
export const useSetLayaDockerUrl = () =>
  useUiPreferencesStore((s) => s.setLayaDockerUrl);

export const useLayaCloudUrl = () =>
  useUiPreferencesStore((s) => s.layaCloudUrl);
export const useSetLayaCloudUrl = () =>
  useUiPreferencesStore((s) => s.setLayaCloudUrl);

export const useJevApiKey = () => useUiPreferencesStore((s) => s.jevApiKey);
export const useSetJevApiKey = () =>
  useUiPreferencesStore((s) => s.setJevApiKey);

export const useJevTypesafeUrl = () =>
  useUiPreferencesStore((s) => s.jevTypesafeUrl);
export const useSetJevTypesafeUrl = () =>
  useUiPreferencesStore((s) => s.setJevTypesafeUrl);

export const useLayaGuardrailsEnabled = () =>
  useUiPreferencesStore((s) => s.layaGuardrailsEnabled);
export const useSetLayaGuardrailsEnabled = () =>
  useUiPreferencesStore((s) => s.setLayaGuardrailsEnabled);

export const useAbideGuardrailsEnabled = () =>
  useUiPreferencesStore((s) => s.abideGuardrailsEnabled);
export const useSetAbideGuardrailsEnabled = () =>
  useUiPreferencesStore((s) => s.setAbideGuardrailsEnabled);

export const useAbideGuardrailsEngine = () =>
  useUiPreferencesStore((s) => s.abideGuardrailsEngine);
export const useSetAbideGuardrailsEngine = () =>
  useUiPreferencesStore((s) => s.setAbideGuardrailsEngine);

export const useAbideGuardrailsAction = () =>
  useUiPreferencesStore((s) => s.abideGuardrailsAction);
export const useSetAbideGuardrailsAction = () =>
  useUiPreferencesStore((s) => s.setAbideGuardrailsAction);

export const useGuardrailProtectedFiles = () =>
  useUiPreferencesStore((s) => s.guardrailProtectedFiles);
export const useSetGuardrailProtectedFiles = () =>
  useUiPreferencesStore((s) => s.setGuardrailProtectedFiles);

export const useGuardrailAiAttribution = () =>
  useUiPreferencesStore((s) => s.guardrailAiAttribution);
export const useSetGuardrailAiAttribution = () =>
  useUiPreferencesStore((s) => s.setGuardrailAiAttribution);

export const useGuardrailSecretLeak = () =>
  useUiPreferencesStore((s) => s.guardrailSecretLeak);
export const useSetGuardrailSecretLeak = () =>
  useUiPreferencesStore((s) => s.setGuardrailSecretLeak);

export const useGuardrailGitOps = () =>
  useUiPreferencesStore((s) => s.guardrailGitOps);
export const useSetGuardrailGitOps = () =>
  useUiPreferencesStore((s) => s.setGuardrailGitOps);

export const useGuardrailSemanticJev = () =>
  useUiPreferencesStore((s) => s.guardrailSemanticJev);
export const useSetGuardrailSemanticJev = () =>
  useUiPreferencesStore((s) => s.setGuardrailSemanticJev);

// Hooks for typography & custom theme
export function useUiFontFamily() {
  const font = useUiPreferencesStore((s) => s.uiFontFamily);
  const set = useUiPreferencesStore((s) => s.setUiFontFamily);
  return [font, set] as const;
}

export function useCodeFontFamily() {
  const font = useUiPreferencesStore((s) => s.codeFontFamily);
  const set = useUiPreferencesStore((s) => s.setCodeFontFamily);
  return [font, set] as const;
}

export function useUiFontScale() {
  const scale = useUiPreferencesStore((s) => s.uiFontScale);
  const set = useUiPreferencesStore((s) => s.setUiFontScale);
  return [scale, set] as const;
}

export function useCodeFontSize() {
  const size = useUiPreferencesStore((s) => s.codeFontSize);
  const set = useUiPreferencesStore((s) => s.setCodeFontSize);
  return [size, set] as const;
}

export function useCustomTheme() {
  const theme = useUiPreferencesStore((s) => s.customTheme);
  const set = useUiPreferencesStore((s) => s.setCustomTheme);
  return [theme, set] as const;
}

export function useCustomThemeEnabled() {
  const enabled = useUiPreferencesStore((s) => s.customThemeEnabled);
  const set = useUiPreferencesStore((s) => s.setCustomThemeEnabled);
  return [enabled, set] as const;
}

export function useSavedCustomThemes() {
  const themes = useUiPreferencesStore((s) => s.savedCustomThemes);
  const save = useUiPreferencesStore((s) => s.saveCurrentCustomTheme);
  const apply = useUiPreferencesStore((s) => s.applySavedCustomTheme);
  const remove = useUiPreferencesStore((s) => s.deleteSavedCustomTheme);
  return { themes, save, apply, remove };
}
