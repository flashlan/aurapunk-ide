import {
  GearIcon,
  PaletteIcon,
  GitBranchIcon,
  CpuIcon,
  PlugIcon,
  TelegramLogoIcon,
  FlowArrowIcon,
  ClockCountdownIcon,
  ChartBarIcon,
  DatabaseIcon,
  ArchiveIcon,
  PuzzlePieceIcon,
  ColumnsIcon,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { lazy, Suspense } from 'react';

// Sections load on demand: the dialog shell and its navigation stay in the
// main bundle, but each section (and what it pulls in — JSON-schema forms,
// charts, the memory graph) is fetched only when opened.
const GeneralSettingsSection = lazy(() =>
  import('./GeneralSettingsSection').then((m) => ({
    default: m.GeneralSettingsSection,
  }))
);
const AppearanceSettingsSection = lazy(() =>
  import('./AppearanceSettingsSection').then((m) => ({
    default: m.AppearanceSettingsSection,
  }))
);
const PipelineSettingsSection = lazy(() =>
  import('./PipelineSettingsSection').then((m) => ({
    default: m.PipelineSettingsSection,
  }))
);
const RecurrentSettingsSection = lazy(() =>
  import('./RecurrentSettingsSection').then((m) => ({
    default: m.RecurrentSettingsSection,
  }))
);
const ReposSettingsSection = lazy(() =>
  import('./ReposSettingsSection').then((m) => ({
    default: m.ReposSettingsSection,
  }))
);
const AgentsSettingsSection = lazy(() =>
  import('./AgentsSettingsSection').then((m) => ({
    default: m.AgentsSettingsSection,
  }))
);
const McpSettingsSection = lazy(() =>
  import('./McpSettingsSection').then((m) => ({
    default: m.McpSettingsSection,
  }))
);
const TelegramSettingsSection = lazy(() =>
  import('./TelegramSettingsSection').then((m) => ({
    default: m.TelegramSettingsSection,
  }))
);
const UsageSettingsSection = lazy(() =>
  import('./UsageSettingsSection').then((m) => ({
    default: m.UsageSettingsSection,
  }))
);
const MemorySettingsSection = lazy(() =>
  import('./MemorySettingsSection').then((m) => ({
    default: m.MemorySettingsSection,
  }))
);
const BackupSettingsSection = lazy(() =>
  import('./BackupSettingsSection').then((m) => ({
    default: m.BackupSettingsSection,
  }))
);
const AddonsSettingsSection = lazy(() =>
  import('./AddonsSettingsSection').then((m) => ({
    default: m.AddonsSettingsSection,
  }))
);
const StatusesSettingsSection = lazy(() =>
  import('./StatusesSettingsSection').then((m) => ({
    default: m.StatusesSettingsSection,
  }))
);

// ADR-018 — `organizations` and `remote-projects` sections are gone.
// Only host-scoped sections remain; the `universal` group is empty.
export type SettingsSectionType =
  | 'general'
  | 'appearance'
  | 'pipeline'
  | 'recurrent'
  | 'repos'
  | 'agents'
  | 'mcp'
  | 'telegram'
  | 'usage'
  | 'memory'
  | 'backup'
  | 'addons'
  | 'statuses';

export type SettingsSectionGroup = 'host';

export type SettingsSectionInitialState = {
  general: undefined;
  appearance: undefined;
  pipeline: undefined;
  recurrent: undefined;
  repos: { repoId?: string } | undefined;
  agents: { executor?: string; variant?: string } | undefined;
  mcp: undefined;
  telegram: undefined;
  usage: undefined;
  memory: undefined;
  backup: undefined;
  addons: undefined;
  statuses: undefined;
};

export interface SettingsSectionDefinition {
  id: SettingsSectionType;
  icon: Icon;
  group: SettingsSectionGroup;
}

export const SETTINGS_SECTION_DEFINITIONS: SettingsSectionDefinition[] = [
  { id: 'general', icon: GearIcon, group: 'host' },
  { id: 'appearance', icon: PaletteIcon, group: 'host' },
  { id: 'pipeline', icon: FlowArrowIcon, group: 'host' },
  { id: 'recurrent', icon: ClockCountdownIcon, group: 'host' },
  { id: 'repos', icon: GitBranchIcon, group: 'host' },
  { id: 'agents', icon: CpuIcon, group: 'host' },
  { id: 'mcp', icon: PlugIcon, group: 'host' },
  { id: 'telegram', icon: TelegramLogoIcon, group: 'host' },
  { id: 'usage', icon: ChartBarIcon, group: 'host' },
  { id: 'memory', icon: DatabaseIcon, group: 'host' },
  { id: 'backup', icon: ArchiveIcon, group: 'host' },
  { id: 'addons', icon: PuzzlePieceIcon, group: 'host' },
  { id: 'statuses', icon: ColumnsIcon, group: 'host' },
];

export function isHostSpecificSettingsSection(
  type: SettingsSectionType
): boolean {
  return (
    SETTINGS_SECTION_DEFINITIONS.find((section) => section.id === type)
      ?.group === 'host'
  );
}

export function renderSettingsSection(
  type: SettingsSectionType,
  initialState?: SettingsSectionInitialState[SettingsSectionType],
  onClose?: () => void
) {
  return (
    <Suspense fallback={<SettingsSectionLoading />}>
      {renderSettingsSectionContent(type, initialState, onClose)}
    </Suspense>
  );
}

function SettingsSectionLoading() {
  return <div className="p-base text-sm text-low">Loading…</div>;
}

function renderSettingsSectionContent(
  type: SettingsSectionType,
  initialState?: SettingsSectionInitialState[SettingsSectionType],
  onClose?: () => void
) {
  switch (type) {
    case 'general':
      return <GeneralSettingsSection />;
    case 'appearance':
      return <AppearanceSettingsSection />;
    case 'pipeline':
      return <PipelineSettingsSection />;
    case 'recurrent':
      return <RecurrentSettingsSection onClose={onClose} />;
    case 'repos':
      return (
        <ReposSettingsSection
          initialState={initialState as SettingsSectionInitialState['repos']}
        />
      );
    case 'agents':
      return <AgentsSettingsSection />;
    case 'mcp':
      return <McpSettingsSection />;
    case 'telegram':
      return <TelegramSettingsSection />;
    case 'usage':
      return <UsageSettingsSection />;
    case 'memory':
      return <MemorySettingsSection />;
    case 'backup':
      return <BackupSettingsSection />;
    case 'addons':
      return <AddonsSettingsSection />;
    case 'statuses':
      return <StatusesSettingsSection />;
    default:
      return <GeneralSettingsSection />;
  }
}
